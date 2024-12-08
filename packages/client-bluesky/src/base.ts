import { Content, IAgentRuntime, State, UUID, Memory } from "@ai16z/eliza";
import { stringToUuid } from "@ai16z/eliza";

import { AtpAgent } from "@atproto/api";

import { EventEmitter } from "events";

import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
    FeedViewPost,
    PostView,
} from "@atproto/api/dist/client/types/app/bsky/feed/defs";
import { elizaLogger, getEmbeddingZeroVector } from "@ai16z/eliza";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type BskyPostRecord = {
    $type: "app.bsky.feed.post";
    createdAt: string;
    embed: object;
    langs: string[];
    reply: {
        parent: {
            cid: string;
            uri: string;
        };
    };
    text: string;
};

export function extractAnswer(text: string): string {
    const startIndex = text.indexOf("Answer: ") + 8;
    const endIndex = text.indexOf("<|endoftext|>", 11);
    return text.slice(startIndex, endIndex);
}

export class ClientBase extends EventEmitter {
    blueskyAgent: AtpAgent;
    runtime: IAgentRuntime;
    directions: string;
    bskyUserDid: string;

    postCacheFilePath = __dirname + "/bskycache/latest_checked_post_cid.txt";

    temperature: number = 0.5;

    private postCache: Map<string, PostView> = new Map();

    async cachePost(post: PostView) {
        if (!post) {
            console.warn("Post is undefined, skipping cache.");
            return;
        }

        const cacheDir = path.join(
            __dirname,
            "bskycache",
            stringToUuid(post.uri).toString(),
            `${stringToUuid(post.uri)}.json`
        );

        await fs.promises.mkdir(path.dirname(cacheDir), { recursive: true });
        await fs.promises.writeFile(cacheDir, JSON.stringify(post, null, 2));
        this.postCache.set(post.uri, post);
    }

    async getCachedPost(postUri: string): Promise<PostView | undefined> {
        if (this.postCache.has(postUri)) {
            return this.postCache.get(postUri);
        }

        const cacheDir = path.join(
            __dirname,
            "bskycache",
            stringToUuid(postUri),
            `${stringToUuid(postUri)}.json`
        );

        if (fs.existsSync(cacheDir)) {
            const post = JSON.parse(
                await fs.promises.readFile(cacheDir, "utf-8")
            );
            this.postCache.set(postUri, post);
            return post;
        }

        return undefined;
    }

    async getPost(postUri: string): Promise<PostView> {
        const cachedPost = await this.getCachedPost(postUri);
        if (cachedPost) {
            return cachedPost;
        }
        const post = await this.blueskyAgent.getPosts({
            uris: [postUri],
        });

        await this.cachePost(post.data.posts[0]);
    }

    callback: (seld: ClientBase) => any = null;

    onReady() {
        throw new Error(
            "Not implemented in base class, please call from subclass"
        );
    }

    constructor({ runtime }: { runtime: IAgentRuntime }) {
        super();
        this.runtime = runtime;

        const username = this.runtime.getSetting("BSKY_USERNAME");
        const password = this.runtime.getSetting("BSKY_PASSWORD");

        if (!username || !password) {
            throw new Error(
                "BSKY_USERNAME and BSKY_PASSWORD must be set in character.json settings.secrets"
            );
        }

        this.blueskyAgent = new AtpAgent({
            service: "https://bsky.social",
        });

        this.blueskyAgent
            .login({
                identifier: username,
                password: password,
            })
            .then(() => {
                this.blueskyAgent
                    .getProfile({
                        actor: this.runtime.getSetting("BSKY_USERNAME"),
                    })
                    .then((profile) => {
                        this.bskyUserDid = profile.data.did;
                    });
                this.directions =
                    "- " +
                    this.runtime.character.style.all.join("\n- ") +
                    "- " +
                    this.runtime.character.style.post.join("\n- ");

                this.onReady();
            })
            .catch((error) => {
                console.error("Failed to login to Bluesky:", error);
            });
    }

    async fetchHomeTimeline(count: number): Promise<FeedViewPost[]> {
        const { data } = await this.blueskyAgent.getTimeline({
            limit: count,
        });
        const { feed: postsArray, cursor: nextPage } = data;

        return postsArray;
    }

    private async populateTimeline() {
        const cacheFile = "bsky_timeline_cache.json";

        if (fs.existsSync(cacheFile)) {
            const cachedResults = JSON.parse(
                fs.readFileSync(cacheFile, "utf-8")
            );

            const existingMemories =
                await this.runtime.messageManager.getMemoriesByRoomIds({
                    roomIds: cachedResults.map((post) =>
                        stringToUuid(post.cid + "-" + this.runtime.agentId)
                    ),
                });

            const existingMemoryIds = new Set(
                existingMemories.map((memory) => memory.id.toString())
            );

            const someCachedPostsExist = cachedResults.some((post) =>
                existingMemoryIds.has(
                    stringToUuid(post.cid + "-" + this.runtime.agentId)
                )
            );

            if (someCachedPostsExist) {
                const postsToSave = cachedResults.filter(
                    (post) =>
                        !existingMemoryIds.has(
                            stringToUuid(post.cid + "-" + this.runtime.agentId)
                        )
                );

                for (const post of postsToSave) {
                    const roomId = stringToUuid(
                        post.threadgate?.cid ??
                            "default-room-" + this.runtime.agentId
                    );

                    const postUserId =
                        post.author.did === this.bskyUserDid
                            ? this.runtime.agentId
                            : stringToUuid(post.author.did);

                    await this.runtime.ensureConnection(
                        postUserId,
                        roomId,
                        post.author.handle,
                        post.author.displayName,
                        "bluesky"
                    );

                    const record = post.record as BskyPostRecord;

                    const content = {
                        text: record.text,
                        url: post.uri,
                        source: "bluesky",
                        inReplyTo: record.reply?.parent?.cid
                            ? stringToUuid(record.reply.parent.cid)
                            : undefined,
                    } as Content;

                    elizaLogger.log("Creating memory for post", post.cid);

                    const memory =
                        await this.runtime.messageManager.getMemoryById(
                            stringToUuid(post.cid + "-" + this.runtime.agentId)
                        );

                    if (memory) {
                        elizaLogger.log(
                            "Memory already exists, skipping timeline population"
                        );
                        break;
                    }

                    await this.runtime.messageManager.createMemory({
                        id: stringToUuid(post.cid + "-" + this.runtime.agentId),
                        userId: postUserId,
                        content: content,
                        agentId: this.runtime.agentId,
                        roomId,
                        embedding: getEmbeddingZeroVector(),
                        createdAt: new Date().getTime(),
                    });
                }

                elizaLogger.log(
                    `Populated ${postsToSave.length} posts from cache`
                );
                return;
            }
        }

        const { data } = await this.blueskyAgent.getAuthorFeed({
            actor: this.bskyUserDid,
            limit: 20,
        });

        const { feed: postsArray } = data;

        const allPostsResponse = await this.blueskyAgent.getPosts({
            uris: postsArray.map((post) => post.post.uri),
        });

        const allPosts = allPostsResponse.data.posts;

        const postCidsToCheck = new Set<string>();

        for (const post of allPosts) {
            postCidsToCheck.add(post.cid);
        }

        const postUuids = Array.from(postCidsToCheck).map((cid) =>
            stringToUuid(cid + "-" + this.runtime.agentId)
        );

        const existingMemories =
            await this.runtime.messageManager.getMemoriesByRoomIds({
                roomIds: postUuids,
            });

        const existingMemoryIds = new Set<UUID>(
            existingMemories.map((memory) => memory.roomId)
        );

        const postsToSave = allPosts.filter(
            (post) =>
                !existingMemoryIds.has(
                    stringToUuid(post.cid + "-" + this.runtime.agentId)
                )
        );

        await this.runtime.ensureUserExists(
            this.runtime.agentId,
            this.runtime.getSetting("BSKY_USERNAME"),
            this.runtime.character.name,
            "bluesky"
        );

        for (const post of postsToSave) {
            const record = post.record as BskyPostRecord;
            const roomId = stringToUuid(
                post.threadgate?.cid ?? "default-room-" + this.runtime.agentId
            );
            const postUserId =
                post.author.did === this.bskyUserDid
                    ? this.runtime.agentId
                    : stringToUuid(post.author.did);

            await this.runtime.ensureConnection(
                postUserId,
                roomId,
                post.author.handle,
                post.author.displayName,
                "bluesky"
            );

            const content = {
                text: record.text,
                url: post.uri,
                source: "bluesky",
                inReplyTo: record.reply?.parent?.cid
                    ? stringToUuid(record.reply.parent.cid)
                    : undefined,
            } as Content;

            await this.runtime.messageManager.createMemory({
                id: stringToUuid(post.cid + "-" + this.runtime.agentId),
                userId: postUserId,
                content: content,
                agentId: this.runtime.agentId,
                roomId,
                embedding: getEmbeddingZeroVector(),
                createdAt: new Date().getTime(),
            });
        }

        fs.writeFileSync(cacheFile, JSON.stringify(allPosts));
    }

    async saveRequestMessage(message: Memory, state: State) {
        if (message.content.text) {
            const recentMessage = await this.runtime.messageManager.getMemories(
                {
                    roomId: message.roomId,
                    count: 1,
                    unique: false,
                }
            );

            if (
                recentMessage.length > 0 &&
                recentMessage[0].content === message.content
            ) {
                console.log("Message already saved", recentMessage[0].id);
            } else {
                await this.runtime.messageManager.createMemory({
                    ...message,
                    embedding: getEmbeddingZeroVector(),
                });
            }

            await this.runtime.evaluate(message, {
                ...state,
                blueskyAgent: this.blueskyAgent,
            });
        }
    }
}
