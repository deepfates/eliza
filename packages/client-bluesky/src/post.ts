import { IAgentRuntime, ModelClass } from "@ai16z/eliza";
import { getEmbeddingZeroVector } from "@ai16z/eliza";
import { generateText } from "@ai16z/eliza";
import { ClientBase } from "./base";

import fs from "fs";
import { stringToUuid } from "@ai16z/eliza";
import { composeContext } from "@ai16z/eliza";

const blueskyPostTemplate = `{{timeline}}

# Knowledge
{{knowledge}}

About {{agentName}} (@{{blueskyUserName}}):
{{bio}}
{{lore}}
{{postDirections}}

{{providers}}

{{recentPosts}}

{{characterPostExamples}}

# Task: Generate a post in the voice and style of {{agentName}}, aka @{{blueskyUserName}}
Write a single sentence post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Try to write something totally different than previous posts. Do not add commentary or ackwowledge this request, just write the post.
Use \n\n (double newlines) between statements.`;

export class BlueskyPostClient extends ClientBase {
    onReady() {
        const generateNewBskyPostLoop = () => {
            this.generateNewBskyPost();
            setTimeout(
                generateNewBskyPostLoop,
                (Math.floor(Math.random() * (4 - 1 + 1)) + 1) * 60 * 60 * 1000
            ); // Random interval between 1 and 4 hours
        };
        generateNewBskyPostLoop();
    }

    constructor(runtime: IAgentRuntime) {
        super({
            runtime,
        });
    }

    private async generateNewBskyPost() {
        console.log("Generating new bluesky post");
        try {
            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.runtime.getSetting("BSKY_USERNAME"),
                this.runtime.character.name,
                "bluesky"
            );

            let homeTimeline = [];

            if (!fs.existsSync("bskycache")) fs.mkdirSync("bskycache");

            if (fs.existsSync("bskycache/home_timeline.json")) {
                homeTimeline = JSON.parse(
                    fs.readFileSync("bskycache/home_timeline.json", "utf-8")
                );
            } else {
                homeTimeline = await this.fetchHomeTimeline(20);
                fs.writeFileSync(
                    "bskycache/home_timeline.json",
                    JSON.stringify(homeTimeline)
                );
            }

            console.log(homeTimeline[0].post.record);

            const formattedHomeTimeline =
                `# ${this.runtime.character.name}'s Home Timeline\n\n` +
                homeTimeline.map(
                    (post) =>
                        `ID: ${post.post.cid}\nFrom: ${post.post.author.displayName} (@${post.post.author.handle})`
                );

            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId: stringToUuid("bsky_generate_room"),
                    agentId: this.runtime.agentId,
                    content: { text: "", action: "" },
                },
                {
                    blueskyUsername: this.runtime.getSetting("BSKY_USERNAME"),
                    timeline: formattedHomeTimeline,
                }
            );

            const context = composeContext({
                state: state as any,
                template:
                    this.runtime.character.templates?.twitterPostTemplate ||
                    blueskyPostTemplate,
            });

            const newPostContent = await generateText({
                runtime: this.runtime as any,
                context,
                modelClass: ModelClass.SMALL,
                stop: undefined,
            });

            const slice = newPostContent.replaceAll(/\\n/g, "\n").trim();

            const contentLength = 240;

            let content = slice.slice(0, contentLength);
            // if its bigger than 280, delete the last line
            if (content.length > 280) {
                content = content.slice(0, content.lastIndexOf("\n"));
            }
            if (content.length > contentLength) {
                // slice at the last period
                content = content.slice(0, content.lastIndexOf("."));
            }

            // if it's still too long, get the period before the last period
            if (content.length > contentLength) {
                content = content.slice(0, content.lastIndexOf("."));
            }

            try {
                const result = await this.blueskyAgent.post({
                    text: content,
                    langs: ["en"],
                    createdAt: new Date().toISOString(),
                });

                const { cid, uri } = result;

                const postData = await this.blueskyAgent.getPosts({
                    uris: [uri],
                });

                const { posts } = postData.data;

                const post = posts[0];
                const postCid = post.cid;
                const conversationId = postCid + "-" + this.runtime.agentId;
                const roomId = stringToUuid(conversationId);

                await this.runtime.ensureRoomExists(roomId);
                await this.runtime.ensureParticipantInRoom(
                    this.runtime.agentId,
                    roomId
                );

                await this.cachePost(post);

                await this.runtime.messageManager.createMemory({
                    id: stringToUuid(postCid + "-" + this.runtime.agentId),
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: newPostContent.trim(),
                        url: post.uri,
                        source: "bluesky",
                    },
                    roomId,
                    embedding: getEmbeddingZeroVector(),
                    createdAt: new Date().getTime(),
                });
            } catch (error) {
                console.error("Error sending post to bluesky:", error);
            }
        } catch (error) {
            console.error("Error generating new post for bluesky:", error);
        }
    }
}
