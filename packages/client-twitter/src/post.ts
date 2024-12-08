import { Tweet } from "agent-twitter-client";
import {
    composeContext,
    generateText,
    generateTweetActions,
    getEmbeddingZeroVector,
    IAgentRuntime,
    ModelClass,
    stringToUuid,
    parseBooleanFromText,
} from "@ai16z/eliza";
import { elizaLogger } from "@ai16z/eliza";
import { ClientBase } from "./base.ts";
import {
    postActionResponseFooter,
    parseActionResponseFromText,
} from "@ai16z/eliza/src/parsing.ts";

const twitterPostTemplate = `
# Areas of Expertise
{{knowledge}}

# About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

# Task: Generate a post in the voice and style and perspective of {{agentName}}, aka @{{twitterUserName}}
Write a 1-3 sentence post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly), from the perspective of {{agentName}}. Try to write something totally different than previous posts. Do not add commentary or acknowledge this request, just write the post.
Use \\n\\n (double newlines) between statements.`;

const MAX_TWEET_LENGTH = 280;

/**
 * Truncate text to fit within the Twitter character limit, ensuring it ends at a complete sentence.
 */
function truncateToCompleteSentence(text: string): string {
    if (text.length <= MAX_TWEET_LENGTH) {
        return text;
    }

    // Attempt to truncate at the last period within the limit
    const truncatedAtPeriod = text.slice(
        0,
        text.lastIndexOf(".", MAX_TWEET_LENGTH) + 1
    );
    if (truncatedAtPeriod.trim().length > 0) {
        return truncatedAtPeriod.trim();
    }

    // If no period is found, truncate to the nearest whitespace
    const truncatedAtSpace = text.slice(
        0,
        text.lastIndexOf(" ", MAX_TWEET_LENGTH)
    );
    if (truncatedAtSpace.trim().length > 0) {
        return truncatedAtSpace.trim() + "...";
    }

    // Fallback: Hard truncate and add ellipsis
    return text.slice(0, MAX_TWEET_LENGTH - 3).trim() + "...";
}

// Template constants
export const twitterActionTemplate =
    `# INSTRUCTIONS: Analyze the following tweet and determine which actions {{agentName}} (@{{twitterUserName}}) should take. Do not comment. Just respond with the appropriate action tags.

About {{agentName}} (@{{twitterUserName}}):
{{bio}}
{{lore}}
{{postDirections}}

Response Guidelines:
- {{agentName}} is selective about engagement and doesn't want to be annoying
- Retweets and quotes are extremely rare, only for exceptionally based content that aligns with {{agentName}}'s character
- Direct mentions get very high priority for replies and quote tweets
- Avoid engaging with:
  * Short or low-effort content
  * Topics outside {{agentName}}'s interests
  * Repetitive conversations

Available Actions and Thresholds:
[LIKE] - Content resonates with {{agentName}}'s interests (medium threshold, 7/10)
[RETWEET] - Exceptionally based content that perfectly aligns with character (very rare to retweet, 9/10)
[QUOTE] - Rare opportunity to add significant value (very high threshold, 8/10)
[REPLY] - highly memetic response opportunity (very high threshold, 8/10)

Current Tweet:
{{currentTweet}}

# INSTRUCTIONS: Respond with appropriate action tags based on the above criteria and the current tweet. An action must meet its threshold to be included.` +
    postActionResponseFooter;

export class TwitterPostClient {
    client: ClientBase;
    runtime: IAgentRuntime;

    async start(postImmediately: boolean = false) {
        if (!this.client.profile) {
            await this.client.init();
        }

        const generateNewTweetLoop = async () => {
            const lastPost = await this.runtime.cacheManager.get<{
                timestamp: number;
            }>(
                "twitter/" +
                    this.runtime.getSetting("TWITTER_USERNAME") +
                    "/lastPost"
            );

            const lastPostTimestamp = lastPost?.timestamp ?? 0;
            const minMinutes =
                parseInt(this.runtime.getSetting("POST_INTERVAL_MIN")) || 90;
            const maxMinutes =
                parseInt(this.runtime.getSetting("POST_INTERVAL_MAX")) || 180;
            const randomMinutes =
                Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) +
                minMinutes;
            const delay = randomMinutes * 60 * 1000;

            if (Date.now() > lastPostTimestamp + delay) {
                await this.generateNewTweet();
            }

            setTimeout(() => {
                generateNewTweetLoop(); // Set up next iteration
            }, delay);

            elizaLogger.log(`Next tweet scheduled in ${randomMinutes} minutes`);
        };

        // Add timeline processing loop
        const generateNewTimelineTweetLoop = async () => {
            await this.processTweetActions();
            const minMinutes =
                parseInt(this.runtime.getSetting("TIMELINE_INTERVAL_MIN")) || 5;
            const maxMinutes =
                parseInt(this.runtime.getSetting("TIMELINE_INTERVAL_MAX")) ||
                30;
            const randomMinutes =
                Math.floor(Math.random() * (maxMinutes - minMinutes + 1)) +
                minMinutes; // Random interval between 5-30 minutes (configurable)
            const delay = randomMinutes * 60 * 1000;

            setTimeout(() => {
                generateNewTimelineTweetLoop(); // Set up next iteration
            }, delay);

            elizaLogger.log(
                `Next timeline processing scheduled in ${randomMinutes} minutes`
            );
        };

        if (
            this.runtime.getSetting("POST_IMMEDIATELY") != null &&
            this.runtime.getSetting("POST_IMMEDIATELY") != ""
        ) {
            postImmediately = parseBooleanFromText(
                this.runtime.getSetting("POST_IMMEDIATELY")
            );
        }
        if (postImmediately) {
            this.generateNewTweet();
            this.processTweetActions();
        }

        generateNewTweetLoop();
        generateNewTimelineTweetLoop(); // Start the timeline processing loop
    }

    constructor(client: ClientBase, runtime: IAgentRuntime) {
        this.client = client;
        this.runtime = runtime;
    }

    private async generateNewTweet() {
        elizaLogger.log("Generating new tweet");

        try {
            const roomId = stringToUuid(
                "twitter_generate_room-" + this.client.profile.username
            );
            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.client.profile.username,
                this.runtime.character.name,
                "twitter"
            );

            const topics = this.runtime.character.topics.join(", ");
            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId: roomId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: topics,
                        action: "",
                    },
                },
                {
                    twitterUserName: this.client.profile.username,
                }
            );

            const context = composeContext({
                state,
                template:
                    this.runtime.character.templates?.twitterPostTemplate ||
                    twitterPostTemplate,
            });

            elizaLogger.debug("generate post prompt:\n" + context);

            const newTweetContent = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            // Replace \n with proper line breaks and trim excess spaces
            const formattedTweet = newTweetContent
                .replaceAll(/\\n/g, "\n")
                .trim();

            // Use the helper function to truncate to complete sentence
            const content = truncateToCompleteSentence(formattedTweet);

            if (this.runtime.getSetting("TWITTER_DRY_RUN") === "true") {
                elizaLogger.info(
                    `Dry run: would have posted tweet: ${content}`
                );
                return;
            }

            try {
                elizaLogger.log(`Posting new tweet:\n ${content}`);

                const result = await this.client.requestQueue.add(
                    async () =>
                        await this.client.twitterClient.sendTweet(content)
                );
                const body = await result.json();
                if (!body?.data?.create_tweet?.tweet_results?.result) {
                    console.error("Error sending tweet; Bad response:", body);
                    return;
                }
                const tweetResult = body.data.create_tweet.tweet_results.result;

                const tweet = {
                    id: tweetResult.rest_id,
                    name: this.client.profile.screenName,
                    username: this.client.profile.username,
                    text: tweetResult.legacy.full_text,
                    conversationId: tweetResult.legacy.conversation_id_str,
                    createdAt: tweetResult.legacy.created_at,
                    timestamp: new Date(
                        tweetResult.legacy.created_at
                    ).getTime(),
                    userId: this.client.profile.id,
                    inReplyToStatusId:
                        tweetResult.legacy.in_reply_to_status_id_str,
                    permanentUrl: `https://twitter.com/${this.runtime.getSetting("TWITTER_USERNAME")}/status/${tweetResult.rest_id}`,
                    hashtags: [],
                    mentions: [],
                    photos: [],
                    thread: [],
                    urls: [],
                    videos: [],
                } as Tweet;

                await this.runtime.cacheManager.set(
                    `twitter/${this.client.profile.username}/lastPost`,
                    {
                        id: tweet.id,
                        timestamp: Date.now(),
                    }
                );

                await this.client.cacheTweet(tweet);

                elizaLogger.log(`Tweet posted:\n ${tweet.permanentUrl}`);

                await this.runtime.ensureRoomExists(roomId);
                await this.runtime.ensureParticipantInRoom(
                    this.runtime.agentId,
                    roomId
                );

                await this.runtime.messageManager.createMemory({
                    id: stringToUuid(tweet.id + "-" + this.runtime.agentId),
                    userId: this.runtime.agentId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: newTweetContent.trim(),
                        url: tweet.permanentUrl,
                        source: "twitter",
                    },
                    roomId,
                    embedding: getEmbeddingZeroVector(),
                    createdAt: tweet.timestamp,
                });
            } catch (error) {
                elizaLogger.error("Error sending tweet:", error);
            }
        } catch (error) {
            elizaLogger.error("Error generating new tweet:", error);
        }
    }

    async processTweetActions() {
        try {
            elizaLogger.log("Generating new advanced tweet posts");

            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.runtime.getSetting("TWITTER_USERNAME"),
                this.runtime.character.name,
                "twitter"
            );

            let homeTimeline = await this.client.fetchHomeTimeline(15);

            const results = [];

            // Process each tweet in the timeline
            for (const tweet of homeTimeline) {
                try {
                    elizaLogger.log(`Processing tweet ID: ${tweet.id}`);

                    // Check if we've already processed this tweet using lastCheckedTweetId
                    if (
                        this.client.lastCheckedTweetId &&
                        BigInt(tweet.id) <= this.client.lastCheckedTweetId
                    ) {
                        elizaLogger.log(
                            `Already processed tweet ${tweet.id}, skipping`
                        );
                        continue;
                    }

                    // Handle memory storage / checking if the tweet has already been posted
                    const tweetId = stringToUuid(
                        tweet.id + "-" + this.runtime.agentId
                    );
                    const memory =
                        await this.runtime.messageManager.getMemoryById(
                            tweetId
                        );

                    if (memory) {
                        elizaLogger.log(
                            `Post interacted with this tweet ID already: ${tweet.id}`
                        );
                        continue;
                    }

                    elizaLogger.log(`new tweet to interact with: ${tweet.id}`);

                    // Save tweet to memory before processing
                    const saveToMemory =
                        await this.saveIncomingTweetToMemory(tweet);
                    if (!saveToMemory) {
                        elizaLogger.log(
                            `Skipping tweet ${tweet.id} due to save failure`
                        );
                        continue;
                    }

                    const formatTweet = (tweet: any): string => {
                        return `ID: ${tweet.id}\nFrom: ${tweet.name} (@${tweet.username})${tweet.inReplyToStatusId ? ` In reply to: ${tweet.inReplyToStatusId}` : ""}\nText: ${tweet.text}\n---\n`;
                    };

                    const formattedTweet = formatTweet(tweet);

                    const tweetState = await this.runtime.composeState(
                        {
                            userId: this.runtime.agentId,
                            roomId: stringToUuid("twitter_generate_room"),
                            agentId: this.runtime.agentId,
                            content: { text: "", action: "" },
                        },
                        {
                            twitterUserName:
                                this.runtime.getSetting("TWITTER_USERNAME"),
                            currentTweet: formattedTweet,
                        }
                    );

                    // Generate action decisions
                    const actionContext = composeContext({
                        state: tweetState,
                        template:
                            this.runtime.character.templates
                                ?.twitterActionTemplate ||
                            twitterActionTemplate,
                    });

                    const actionResponse = await generateTweetActions({
                        runtime: this.runtime,
                        context: actionContext,
                        modelClass: ModelClass.MEDIUM,
                    });

                    if (!actionResponse) {
                        elizaLogger.log(
                            `No valid actions generated for tweet ${tweet.id}`
                        );
                        continue;
                    }

                    // Execute the actions
                    const executedActions: string[] = [];

                    try {
                        // Like action
                        if (actionResponse.like) {
                            // const likeResponse =
                            try {
                                await this.client.twitterClient.likeTweet(
                                    tweet.id
                                );
                                elizaLogger.log(
                                    `Successfully liked tweet ${tweet.id}`
                                );
                                executedActions.push("like");
                            } catch (error) {
                                elizaLogger.error(
                                    `Error liking tweet ${tweet.id}:`,
                                    error
                                );
                                // Continue with other actions even if retweet fails
                            }
                            // const likeData = await likeResponse.json();

                            // Check if like was successful
                            // if (likeResponse.status === 200 && likeData?.data?.favorite_tweet) {
                            //     elizaLogger.log(`Successfully liked tweet ${tweet.id}`);
                            //     executedActions.push('like');
                            // } else {
                            //     elizaLogger.error(`Failed to like tweet ${tweet.id}`, likeData);

                            //     if (likeData?.errors) {
                            //         elizaLogger.error('Like errors:', likeData.errors);
                            //         executedActions.push('like');
                            //     }
                            // }
                        }

                        // Retweet action
                        if (actionResponse.retweet) {
                            try {
                                // const retweetResponse =
                                await this.client.twitterClient.retweet(
                                    tweet.id
                                );
                                executedActions.push("retweet");
                                elizaLogger.log(
                                    `Successfully retweeted tweet ${tweet.id}`
                                );
                                // Check if response is ok and parse response
                                //     if (retweetResponse.status === 200) {
                                //         const retweetData = await retweetResponse.json();
                                //         if (retweetData) { // if we got valid data back
                                //             executedActions.push('retweet');
                                //             elizaLogger.log(`Successfully retweeted tweet ${tweet.id}`);
                                //         } else {
                                //             elizaLogger.error(`Retweet response invalid for tweet ${tweet.id}`, retweetData);
                                //         }
                                //     } else {
                                //         elizaLogger.error(`Retweet failed with status ${retweetResponse.status} for tweet ${tweet.id}`);
                                //     }
                            } catch (error) {
                                elizaLogger.error(
                                    `Error retweeting tweet ${tweet.id}:`,
                                    error
                                );
                                // Continue with other actions even if retweet fails
                            }
                        }

                        // Quote tweet action
                        if (actionResponse.quote) {
                            let tweetContent = "";
                            try {
                                tweetContent =
                                    await this.generateTweetContent(tweetState);
                                elizaLogger.log(
                                    "Generated tweet content:",
                                    tweetContent
                                );
                            } catch (error) {
                                elizaLogger.error(
                                    "Failed to generate tweet content:",
                                    error
                                );
                            }

                            try {
                                const quoteResponse =
                                    await this.client.twitterClient.sendQuoteTweet(
                                        tweetContent,
                                        tweet.id
                                    );
                                // Check if response is ok and parse response
                                if (quoteResponse.status === 200) {
                                    const result =
                                        await this.processTweetResponse(
                                            quoteResponse,
                                            tweetContent,
                                            "quote"
                                        );
                                    if (result.success) {
                                        executedActions.push("quote");
                                    }
                                } else {
                                    elizaLogger.error(
                                        `Quote tweet failed with status ${quoteResponse.status} for tweet ${tweet.id}`
                                    );
                                }
                            } catch (error) {
                                elizaLogger.error(
                                    `Error quote tweeting ${tweet.id}:`,
                                    error
                                );
                                // Log the attempted quote text for debugging
                                elizaLogger.error(
                                    "Attempted quote text:",
                                    actionResponse.quote
                                );
                                // Continue with other actions even if quote tweet fails
                            }
                        }

                        // Reply action
                        if (actionResponse.reply) {
                            elizaLogger.log("text reply only started...");
                            await this.handleTextOnlyReply(
                                tweet,
                                tweetState,
                                executedActions
                            );
                        }

                        elizaLogger.log(
                            `Executed actions for tweet ${tweet.id}:`,
                            executedActions
                        );

                        // Store the results for this tweet
                        results.push({
                            tweetId: tweet.id,
                            parsedActions: actionResponse,
                            executedActions,
                        });
                    } catch (error) {
                        elizaLogger.error(
                            `Error executing actions for tweet ${tweet.id}:`,
                            error
                        );
                        continue;
                    }

                    // Update lastCheckedTweetId after processing
                    this.client.lastCheckedTweetId = BigInt(tweet.id);
                } catch (error) {
                    elizaLogger.error(
                        `Error processing tweet ${tweet.id}:`,
                        error
                    );
                    continue;
                }
            }

            // Save the latest checked tweet ID
            await this.client.cacheLatestCheckedTweetId();

            return results;
        } catch (error) {
            elizaLogger.error("Error in processTweetActions:", error);
            throw error;
        }
    }

    async generateTweetContent(
        this: any, // to access the class properties
        tweetState: any
    ): Promise<string> {
        try {
            const context = composeContext({
                state: tweetState,
                template: twitterPostTemplate,
            });

            elizaLogger.log(`Beginning to generate new tweet with model`);
            const newTweetContent = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.MEDIUM,
            });

            const slice = newTweetContent.replaceAll(/\\n/g, "\n").trim();
            elizaLogger.log(`New Tweet Post Content with model: ${slice}`);

            const contentLength = 240;

            let content = slice.slice(0, contentLength);

            // if its bigger than 280, delete the last line
            if (content.length > 280) {
                content = content.slice(0, content.lastIndexOf("\n"));
            }

            // Slice at the last period if still too long
            if (content.length > contentLength) {
                content = content.slice(0, content.lastIndexOf("."));
            }

            // if it's still too long, get the period before the last period
            if (content.length > contentLength) {
                content = content.slice(0, content.lastIndexOf("."));
            }

            return content;
        } catch (error) {
            elizaLogger.error("Error generating tweet content:", error);
            throw error;
        }
    }

    async processTweetResponse(
        response: Response,
        tweetContent: string,
        actionType: "quote" | "reply"
    ) {
        try {
            const body = await response.json();
            // elizaLogger.log("Body tweet result: ", body);
            const tweetResult = body.data.create_tweet.tweet_results.result;
            elizaLogger.log("tweetResult", tweetResult);

            const newTweet = {
                id: tweetResult.rest_id,
                text: tweetResult.legacy.full_text,
                conversationId: tweetResult.legacy.conversation_id_str,
                createdAt: tweetResult.legacy.created_at,
                userId: tweetResult.legacy.user_id_str,
                inReplyToStatusId: tweetResult.legacy.in_reply_to_status_id_str,
                permanentUrl: `https://twitter.com/${this.runtime.getSetting("TWITTER_USERNAME")}/status/${tweetResult.rest_id}`,
                hashtags: [],
                mentions: [],
                photos: [],
                thread: [],
                urls: [],
                videos: [],
            } as Tweet;

            const postId = newTweet.id;
            const conversationId =
                newTweet.conversationId + "-" + this.runtime.agentId;
            const roomId = stringToUuid(conversationId);

            // make sure the agent is in the room
            await this.runtime.ensureRoomExists(roomId);
            await this.runtime.ensureParticipantInRoom(
                this.runtime.agentId,
                roomId
            );

            await this.client.cacheTweet(newTweet);

            await this.runtime.messageManager.createMemory({
                id: stringToUuid(postId + "-" + this.runtime.agentId),
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId,
                content: {
                    text: tweetContent.trim(),
                    url: newTweet.permanentUrl,
                    source: "twitter",
                },
                roomId,
                embedding: getEmbeddingZeroVector(),
                createdAt: newTweet.timestamp * 1000,
            });

            return {
                success: true,
                tweet: newTweet,
                actionType,
            };
        } catch (error) {
            elizaLogger.error(
                `Error processing ${actionType} tweet response:`,
                error
            );
            return {
                success: false,
                error,
                actionType,
            };
        }
    }

    private async handleTextOnlyReply(
        tweet: any,
        tweetState: any,
        executedActions: string[]
    ) {
        try {
            const tweetContent = await this.generateTweetContent(tweetState);
            elizaLogger.log("Generated text only tweet content:", tweetContent);

            const tweetResponse = await this.client.twitterClient.sendTweet(
                tweetContent,
                tweet.id
            );
            if (tweetResponse.status === 200) {
                elizaLogger.log(
                    "Successfully tweeted with reply to timeline post"
                );
                const result = await this.processTweetResponse(
                    tweetResponse,
                    tweetContent,
                    "reply"
                );
                if (result.success) {
                    elizaLogger.log(
                        `Reply generated for timeline tweet: ${result.tweet.id}`
                    );
                    executedActions.push("reply");
                }
            } else {
                elizaLogger.error("Tweet creation failed (reply)");
            }
        } catch (error) {
            elizaLogger.error(
                "Failed to generate tweet content for timeline reply:",
                error
            );
        }
    }

    async saveIncomingTweetToMemory(tweet: Tweet, tweetContent?: string) {
        try {
            const postId = tweet.id;
            const conversationId =
                tweet.conversationId + "-" + this.runtime.agentId;
            const roomId = stringToUuid(conversationId);

            // make sure the agent is in the room
            await this.runtime.ensureRoomExists(roomId);
            await this.runtime.ensureParticipantInRoom(
                this.runtime.agentId,
                roomId
            );

            await this.client.cacheTweet(tweet);

            await this.runtime.messageManager.createMemory({
                id: stringToUuid(postId + "-" + this.runtime.agentId),
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId,
                content: {
                    text: tweetContent ? tweetContent.trim() : tweet.text,
                    url: tweet.permanentUrl,
                    source: "twitter",
                },
                roomId,
                embedding: getEmbeddingZeroVector(),
                createdAt: tweet.timestamp * 1000,
            });

            elizaLogger.log(`Saved tweet ${postId} to memory`);
            return true;
        } catch (error) {
            elizaLogger.error(
                `Error saving tweet ${tweet.id} to memory:`,
                error
            );
            return false;
        }
    }
}
