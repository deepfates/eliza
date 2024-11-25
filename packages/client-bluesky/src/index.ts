import { BlueskyPostClient } from "./post";
import { IAgentRuntime, Client } from "@ai16z/eliza";

class BlueskyAllClient {
    post: BlueskyPostClient;

    constructor(runtime: IAgentRuntime) {
        this.post = new BlueskyPostClient(runtime);
    }
}

export const BlueskyClientInterface: Client = {
    async start(runtime: IAgentRuntime) {
        console.log("Bluesky client started");
        return new BlueskyAllClient(runtime);
    },
    async stop(runtime: IAgentRuntime) {
        console.warn("Bluesky client does not support stopping yet");
    },
};

export default BlueskyAllClient;
