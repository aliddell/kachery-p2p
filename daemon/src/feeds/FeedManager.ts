import { assert } from 'console';
import { getSignatureJson, hexToPublicKey, verifySignatureJson } from '../common/crypto_util';
import GarbageMap from '../common/GarbageMap';
import { randomAlphaString, sleepMsec } from '../common/util';
import { LocalFeedManagerInterface } from '../external/ExternalInterface';
import { DurationMsec, durationMsecToNumber, FeedId, feedIdToPublicKeyHex, FeedName, feedSubfeedId, FeedSubfeedId, FindLiveFeedResult, JSONObject, messageCount, MessageCount, messageCountToNumber, nowTimestamp, PrivateKey, PublicKey, scaledDurationMsec, Signature, SignedSubfeedMessage, SubfeedAccessRules, SubfeedHash, SubfeedMessage, subfeedPosition, SubfeedPosition, subfeedPositionToNumber, SubfeedWatch, SubfeedWatchesRAM, SubfeedWatchName, SubmittedSubfeedMessage, submittedSubfeedMessageToSubfeedMessage } from '../interfaces/core';
import KacheryP2PNode from '../KacheryP2PNode';

class FeedManager {
    // Manages the local feeds and access to the remote feeds in the p2p network
    #node: KacheryP2PNode // The kachery-p2p daemon
    #localFeedManager: LocalFeedManagerInterface
    #subfeeds = new GarbageMap<FeedSubfeedId, Subfeed>(scaledDurationMsec(8 * 60 * 1000)) // The subfeed instances (Subfeed()) that have been loaded into memory
    #remoteFeedManager: RemoteFeedManager // Manages the interaction with feeds on remote nodes
    constructor(node: KacheryP2PNode, localFeedManager: LocalFeedManagerInterface) {
        this.#node = node
        this.#localFeedManager = localFeedManager
        this.#remoteFeedManager = new RemoteFeedManager(this.#node);
    }
    async createFeed({ feedName } : {feedName: FeedName | null }) {
        // Create a new writeable feed on this node and return the ID of the new feed

        return await this.#localFeedManager.createFeed(feedName)
    }
    async deleteFeed({ feedId }: {feedId: FeedId}) {
        await this.#localFeedManager.deleteFeed(feedId)
    }
    async getFeedId({ feedName }: { feedName: FeedName }) {
        return await this.#localFeedManager.getFeedId(feedName)
    }
    async hasWriteableFeed({ feedId }: { feedId: FeedId }) {
        return await this.#localFeedManager.hasWriteableFeed(feedId)
    }
    async appendMessages(args: { feedId: FeedId, subfeedHash: SubfeedHash, messages: SubfeedMessage[]}) {
        // assert(Array.isArray(messages));
        // Append messages to a subfeed (must be in a writeable feed on this node)

        // Load the subfeed and make sure it is writeable
        const subfeed = await this._loadSubfeed({feedId: args.feedId, subfeedHash: args.subfeedHash});
        if (!subfeed) {
            /* istanbul ignore next */
            throw Error(`Unable to load subfeed: ${args.feedId} ${args.subfeedHash}`);
        }
        if (!subfeed.isWriteable()) {
            throw Error(`Subfeed is not writeable: ${args.feedId} ${args.subfeedHash}`);
        }

        // Append the messages
        subfeed.appendMessages(args.messages, {metaData: undefined});
    }
    async submitMessage({ feedId, subfeedHash, message, timeoutMsec }: { feedId: FeedId, subfeedHash: SubfeedHash, message: SubmittedSubfeedMessage, timeoutMsec: DurationMsec}) {
        // Same as appendMessages, except if we don't have a writeable feed, we submit it to the p2p network
        // and then, on success, it will append the messages on the node where the feed is writeable
        const subfeed = await this._loadSubfeed({feedId, subfeedHash});
        if (!subfeed) {
            /* istanbul ignore next */
            throw Error(`Unable to load subfeed: ${feedId} ${subfeedHash}`);
        }
        if (subfeed.isWriteable()) {
            // If writeable, let's just append the messages
            await this.appendMessages({feedId, subfeedHash, messages: [submittedSubfeedMessageToSubfeedMessage(message)]});
            return
            // throw Error(`Cannot submit messages. Subfeed is writeable: ${feedId} ${subfeedHash}`);
        }
        // Submit the messages to the p2p network
        await this.#remoteFeedManager.submitMessage({feedId, subfeedHash, message, timeoutMsec});
    }
    // async appendSignedMessages({ feedId, subfeedHash, signedMessages}: {feedId: FeedId, subfeedHash: SubfeedHash, signedMessages: SignedSubfeedMessage[]}) {
    //     // Append signed messages to the local version of a feed.
    //     // This feed does not need to be writeable on this node. If the signatures
    //     // are correct, then we know that they are valid. These will typically come from a remote node.
    //     const subfeed = await this._loadSubfeed({feedId, subfeedHash});
    //     if (!subfeed) {
    //         throw Error(`Unable to load subfeed: ${feedId} ${subfeedHash}`);
    //     }
    //     subfeed.appendSignedMessages(signedMessages);
    // }
    async getMessages({ feedId, subfeedHash, position, maxNumMessages, waitMsec }: {feedId: FeedId, subfeedHash: SubfeedHash, position: SubfeedPosition, maxNumMessages: MessageCount, waitMsec: DurationMsec}) {
        // Load messages from a subfeed.
        // If there are no messages available locally, and waitMsec > 0, then we will search
        // for the messages on the p2p network

        // Get the signed messages
        const signedMessages = await this.getSignedMessages({ feedId, subfeedHash, position, maxNumMessages, waitMsec})

        // Return just the messages (not the signed messages)
        return signedMessages.map(sm => (sm.body.message));
    }
    async getSignedMessages({ feedId, subfeedHash, position, maxNumMessages, waitMsec }: {feedId: FeedId, subfeedHash: SubfeedHash, position: SubfeedPosition, maxNumMessages: MessageCount, waitMsec: DurationMsec}) {
        // Same as getMessages() except we return the signed messages. This is also called by getMessages().
        const subfeed = await this._loadSubfeed({feedId, subfeedHash});
        if (!subfeed) {
            /* istanbul ignore next */
            throw Error(`Unable to load subfeed: ${feedId} ${subfeedHash}`);
        }
        const signedMessages = await subfeed.getSignedMessages({ position, maxNumMessages, waitMsec });
        return signedMessages;
    }
    async getNumMessages({ feedId, subfeedHash }: {feedId: FeedId, subfeedHash: SubfeedHash}): Promise<MessageCount> {
        // Get the total number of messages in the local feed only
        // future: we may want to optionally do a p2p search, and retrieve the number of messages without retrieving the actual messages
        const subfeed = await this._loadSubfeed({feedId, subfeedHash});
        if (!subfeed) {
            /* istanbul ignore next */
            throw Error(`Unable to load subfeed: ${feedId} ${subfeedHash}`);
        }
        return subfeed.getNumMessages()
    }
    async getFeedInfo({ feedId, timeoutMsec }: {feedId: FeedId, timeoutMsec: DurationMsec}): Promise<FindLiveFeedResult> {
        // Get the p2p information about the feed
        // If this is a local and writeable, just return {isWriteable: true}
        // Otherwise we search the p2p network for the feed and if it is found we return {isWriteable: false}
        // Otherwise, if not found, throws an exception
        const privateKey = await this.#localFeedManager.getPrivateKeyForFeed(feedId)
        if (privateKey) {
            return {
                nodeId: this.#node.nodeId(),
                channelName: null
            }
        }
        else {
            // Get the liveFeedInfo. If not found, this will throw an error.
            const liveFeedInfo = await this.#remoteFeedManager.findLiveFeedInfo({feedId, timeoutMsec});
            return liveFeedInfo;
        }
    }
    async getAccessRules({ feedId, subfeedHash }: {feedId: FeedId, subfeedHash: SubfeedHash}): Promise<SubfeedAccessRules | null> {
        // Get the access rules for a local writeable subfeed
        // These determine which remote nodes have permission to submit messages
        // to this subfeed.
        const subfeed = await this._loadSubfeed({feedId, subfeedHash});
        if (!subfeed) {
            /* istanbul ignore next */
            throw Error(`Unable to load subfeed: ${feedId} ${subfeedHash}`);
        }
        if (!subfeed.isWriteable()) {
            throw Error('Cannot get access rules for subfeed that is not writeable')
        }
        return await subfeed.getAccessRules();
    }
    async setAccessRules({ feedId, subfeedHash, accessRules }: {feedId: FeedId, subfeedHash: SubfeedHash, accessRules: SubfeedAccessRules}) {
        // Set the access rules for a local writeable subfeed
        // These determine which remote nodes have permission to submit messages to this subfeed
        // to this subfeed.
        const subfeed = await this._loadSubfeed({feedId, subfeedHash});
        if (!subfeed) {
            /* istanbul ignore next */
            throw Error(`Unable to load subfeed: ${feedId} ${subfeedHash}`);
        }
        if (!subfeed.isWriteable()) {
            throw Error('Cannot set access rules for subfeed that is not writeable')
        }
        subfeed.setAccessRules(accessRules)
    }
    async watchForNewMessages({
        subfeedWatches,
        waitMsec,
        maxNumMessages
    }: {
        subfeedWatches: SubfeedWatchesRAM,
        waitMsec: DurationMsec,
        maxNumMessages: MessageCount
    }): Promise<Map<SubfeedWatchName, (SubfeedMessage[])>> {
        // assert(typeof(waitMsec) === 'number');
        // assert(typeof(waxNumMessages) === 'number');
        return new Promise((resolve, reject) => {
            // Wait until new messages are received on one or more subfeeds, and return information on which watches were triggered

            let finished = false;

            const messages = new Map<SubfeedWatchName, SubfeedMessage[]>();

            let numMessages = 0;
            const doFinish = async () => {
                if (finished) return;
                if (numMessages > 0) {
                    // maybe we have other messages coming in at exactly the same time. Wait a bit for those
                    await sleepMsec(scaledDurationMsec(30));
                }
                finished = true;
                resolve(messages);
            }

            subfeedWatches.forEach((w: SubfeedWatch, watchName: SubfeedWatchName) => {
                (async () => {
                    const subfeed = await this._loadSubfeed({feedId: w.feedId, subfeedHash: w.subfeedHash});
                    if (subfeed) {
                        const messages0 = await subfeed.getSignedMessages({position: w.position, maxNumMessages, waitMsec});
                        if (messages0.length > 0) {
                            messages.set(watchName, messages0.map(m => m.body.message));
                            numMessages += messages0.length;
                            if (!finished) doFinish();
                        }
                    }
                })();
            })

            setTimeout(() => {
                if (!finished) doFinish();
            }, durationMsecToNumber(waitMsec));
        });
    }
    async _loadSubfeed({feedId, subfeedHash}: {feedId: FeedId, subfeedHash: SubfeedHash}) {
        // Load a subfeed (Subfeed() instance

        // If we have already loaded it into memory, then do not reload
        const k = feedSubfeedId(feedId, subfeedHash);
        const subfeed = this.#subfeeds.get(k) || null;

        if (subfeed) {
            await subfeed.waitUntilInitialized();
        }
        else {
            // Instantiate and initialize the subfeed
            const sf = new Subfeed({ node: this.#node, remoteFeedManager: this.#remoteFeedManager, feedId, subfeedHash, localFeedManager: this.#localFeedManager });
            // Store in memory for future access (the order is important here, see waitUntilInitialized above)
            this.#subfeeds.set(k, sf);

            // Load private key if this is writeable (otherwise, privateKey will be null)
            // important to do this after setting this.#subfeeds(k), because we need to await it
            const privateKey = await this.#localFeedManager.getPrivateKeyForFeed(feedId)

            try {
                await sf.initialize(privateKey)
            }
            catch(err) {
                /* istanbul ignore next */
                this.#subfeeds.delete(k)
                /* istanbul ignore next */
                throw err;
            }
        }
        
        // Return the subfeed instance
        return this.#subfeeds.get(k);
    }
}

class RemoteFeedManager {
    #node: KacheryP2PNode
    #liveFeedInfos = new GarbageMap<FeedId, FindLiveFeedResult>(scaledDurationMsec(5 * 60 * 1000)) // Information about the live feeds (cached in memory)
    // Manages interactions with feeds on remote nodes within the p2p network
    constructor(node: KacheryP2PNode) {
        this.#node = node; // The kachery-p2p node
    }
    async getSignedMessages({feedId, subfeedHash, position, maxNumMessages, waitMsec}: {feedId: FeedId, subfeedHash: SubfeedHash, position: SubfeedPosition, maxNumMessages: MessageCount, waitMsec: DurationMsec}): Promise<SignedSubfeedMessage[] | null> {
        // Get signed messages from a remote feed

        let w = durationMsecToNumber(waitMsec)

        // Search and find the info for the feed (channel and node id)
        // If not found, return null
        let liveFeedInfo
        while (true) {
            try {
                liveFeedInfo = await this.findLiveFeedInfo({feedId, timeoutMsec: waitMsec})
                break
            }
            catch(err) {
                return null
            }
        }

        const channelName = liveFeedInfo.channelName
        if (channelName === null) {
            throw Error('Unexpected null channelName when we expect the live feed to be on a remote node (getSignedMessages)')
        }

        // Now that we know the channel and nodeId, we can get the messages from the swarm
        const signedMessages = await this.#node.getRemoteLiveFeedSignedMessages({
            nodeId: liveFeedInfo.nodeId,
            channelName,
            feedId,
            subfeedHash,
            position,
            maxNumMessages,
            waitMsec
        });

        // Return the retrieved messages
        return signedMessages;
    }
    async submitMessage(args: {feedId: FeedId, subfeedHash: SubfeedHash, message: SubmittedSubfeedMessage, timeoutMsec: DurationMsec}) {
        const {feedId, subfeedHash, message, timeoutMsec} = args;

        // Submit messages to a subfeed on a remote node
        // This requires write permissions

        // Search and find the info for the feed (channel and nodeId)
        let waitMsec = 2000;
        let liveFeedInfo;
        while (true) {
            try {
                liveFeedInfo = await this.findLiveFeedInfo({feedId, timeoutMsec});
                break;
            }
            catch(err) {
                if (waitMsec >= 2000) {
                    // wait and try again
                    await sleepMsec(scaledDurationMsec(2000));
                    waitMsec -= 2000;
                }
                else {
                    break;
                }
            }
        }

        // If we did not find it, then throw exception
        if (!liveFeedInfo) {
            throw Error(`Cannot find live feed: ${feedId}`);
        }

        const channelName = liveFeedInfo.channelName
        if (channelName === null) {
            throw Error('Unexpected null channelName when we expect the live feed to be on a remote node (submitMessage)')
        }

        // Now that we know the channel and nodeId, we can submit the messages via the swarm
        await this.#node.submitMessageToRemoteLiveFeed({
            nodeId: liveFeedInfo.nodeId,
            channelName,
            feedId,
            subfeedHash,
            message,
            timeoutMsec
        });
    }
    async findLiveFeedInfo({feedId, timeoutMsec}: {feedId: FeedId, timeoutMsec: DurationMsec}): Promise<FindLiveFeedResult> {
        // Find the channel and nodeId for a feed that is owned by a remote node on the p2p network
        // If not found, throws an error.

        // First check if we have the information in the memory cache
        const cachedInfo = this.#liveFeedInfos.get(feedId);
        if (cachedInfo) return cachedInfo;

        const x = await this.#node.findLiveFeed({feedId, timeoutMsec});
        if (x === null) {
            throw Error('Unable to find live feed.');
        }

        // Store in memory cache
        this.#liveFeedInfos.set(feedId, x);
        return x;
    }
}

interface SubfeedParams {
    node: KacheryP2PNode,
    localFeedManager: LocalFeedManagerInterface,
    remoteFeedManager: RemoteFeedManager,
    feedId: FeedId,
    subfeedHash: SubfeedHash
}

interface ListenerId extends String {
    __listenerId__: never; // phantom
}
const createListenerId = (): ListenerId => {
    return randomAlphaString(10) as any as ListenerId;
}

class Subfeed {
    // Represents a subfeed, which may or may not be writeable on this node
    #localFeedManager: LocalFeedManagerInterface
    #node : KacheryP2PNode // The kachery-p2p daemon
    #feedId: FeedId // The ID of the feed
    #publicKey: PublicKey // The public key of the feed (which is determined by the feed ID)
    #privateKey: PrivateKey | null // The private key (or null if this is not writeable on the local node) -- set below
    #subfeedHash: SubfeedHash // The hash of the subfeed
    #subfeedMessagesPath: string // The text file containing the actual messages (JSON strings on lines of text)
    #signedMessages: SignedSubfeedMessage[] | null = null // The signed messages loaded from the messages file (in-memory cache)
    #accessRules: SubfeedAccessRules | null = null // Access rules for this subfeed -- like which nodes on the p2p network have permission to submit messages
    #isWriteable: boolean | null = null
    #remoteFeedManager: RemoteFeedManager // The remote feed manager, allowing us to retrieve data from remote nodes
    
    #initialized: boolean = false;
    #initializing: boolean = false;
    
    #onInitializedCallbacks: (() => void)[] = [];
    #onInitializeErrorCallbacks: ((err: Error) => void)[] = [];
    #newMessageListeners = new Map<ListenerId, () => void>();

    constructor(params: SubfeedParams) {
        this.#node = params.node; // The kachery-p2p daemon
        this.#feedId = params.feedId; // The ID of the feed
        this.#publicKey = hexToPublicKey(feedIdToPublicKeyHex(this.#feedId)); // The public key of the feed (which is determined by the feed ID)
        this.#subfeedHash = params.subfeedHash; // The hash of the subfeed
        this.#localFeedManager = params.localFeedManager
        this.#remoteFeedManager = params.remoteFeedManager // The remote feed manager, allowing us to retrieve data from remote nodes
    }
    async initialize(privateKey: PrivateKey | null) {
        this.#privateKey = privateKey
        if (this.#initialized) return
        if (this.#initializing) {
            await this.waitUntilInitialized()
            return
        }
        try {
            this.#initializing = true
            // Check whether we have the feed locally (may or may not be locally writeable)
            const existsLocally = this.#localFeedManager.feedExistsLocally(this.#feedId)
            if (existsLocally) {
                const messages = await this.#localFeedManager.getSignedSubfeedMessages(this.#feedId, this.#subfeedHash)

                // Verify the integrity of the messages
                // The first message has a previousSignature of null
                let previousSignature: Signature | null = null
                let previousMessageNumber: number = -1
                for (let msg of messages) {
                    if (!verifySignatureJson(msg.body as any as JSONObject, msg.signature, this.#publicKey)) {
                        /* istanbul ignore next */
                        throw Error(`Unable to verify signature of message in feed: ${msg.signature}`)
                    }
                    if (previousSignature !== (msg.body.previousSignature || null)) {
                        /* istanbul ignore next */
                        throw Error(`Inconsistent previousSignature of message in feed when reading messages from file: ${previousSignature} ${msg.body.previousSignature}`)
                    }
                    if (previousMessageNumber + 1 !== msg.body.messageNumber) {
                        /* istanbul ignore next */
                        throw Error(`Incorrect message number for message in feed when reading messages from file: ${previousMessageNumber + 1} ${msg.body.messageNumber}`)
                    }
                    previousSignature = msg.signature
                    previousMessageNumber = msg.body.messageNumber
                }

                // store in memory
                this.#signedMessages = messages

                // If this is a writeable feed, we also load the access rules into memory
                this.#isWriteable = await this.#localFeedManager.hasWriteableFeed(this.#feedId)
                if (this.#isWriteable) {
                    const accessRules = await this.#localFeedManager.getSubfeedAccessRules(this.#feedId, this.#subfeedHash)
                    if (accessRules) {
                        this.#accessRules = accessRules
                    }
                    else {
                        this.#accessRules = null
                    }
                }
            }
            else {
                this.#isWriteable = false

                // Otherwise, we don't have it locally -- so let's just initialize things
                const messages = await this.#localFeedManager.getSignedSubfeedMessages(this.#feedId, this.#subfeedHash)
                assert(messages.length === 0)

                this.#signedMessages = messages
                this.#accessRules = null

                // Let's try to load messages from remote nodes on the p2p network
                await this.getSignedMessages({position: subfeedPosition(0), maxNumMessages: messageCount(10), waitMsec: scaledDurationMsec(1)})
            }
        }
        catch(err) {
            this.#onInitializeErrorCallbacks.forEach(cb => {cb(err)})
            throw err
        }

        this.#initializing = false
        this.#initialized = true

        this.#onInitializedCallbacks.forEach(cb => {cb()})
    }
    async waitUntilInitialized() {
        if (this.#initialized) return
        return new Promise((resolve, reject) => {
            this.#onInitializeErrorCallbacks.push((err: Error) => {
                reject(err)
            })
            this.#onInitializedCallbacks.push(() => {
                resolve()
            })
        });
    }
    getNumMessages(): MessageCount {
        // Return the number of messages that are currently loaded into memory
        if (this.#signedMessages === null) {
            /* istanbul ignore next */
            throw Error('#signedMessages is null. Perhaps getNumMessages was called before subfeed was initialized.');
        }
        return messageCount(this.#signedMessages.length)
    }
    isWriteable(): boolean {
        // Whether this subfeed is writeable. That depends on whether we have a private key
        if (this.#isWriteable === null) {
            /* istanbul ignore next */
            throw Error('#isWriteable is null. Perhaps isWriteable was called before subfeed was initialized.');
        }
        return this.#isWriteable
    }
    // async remoteNodeHasWriteAccess(remoteNodeId: NodeId) {
    //     // Check whether a remote node has permission to submit messages to this subfeed
    //     if (!this.#accessRules) return false;
    //     if (!this.#accessRules.rules) return false;
    //     const a = this.#accessRules.rules.filter(r => ((r.nodeId === remoteNodeId) && (r.write)));
    //     return (a.length > 0);
    // }
    _getInMemorySignedMessages({position, maxNumMessages}: {position: SubfeedPosition, maxNumMessages: MessageCount}): SignedSubfeedMessage[] {
        if (!this.#signedMessages) {
            /* istanbul ignore next */
            throw Error('_signedMessages is null. Perhaps _getInMemorySignedMessages was called before subfeed was initialized.');
        }
        let signedMessages: SignedSubfeedMessage[] = [];
        if (subfeedPositionToNumber(position) < this.#signedMessages.length) {
            // If we have some messages loaded into memory, let's return those!
            for (let i = subfeedPositionToNumber(position); i < this.#signedMessages.length; i++) {
                signedMessages.push(this.#signedMessages[i]);
                if (maxNumMessages) {
                    if (signedMessages.length >= messageCountToNumber(maxNumMessages)) {
                        break;
                    }
                }
            }
        }
        return signedMessages;
    }
    async getSignedMessages({position, maxNumMessages, waitMsec}: {position: SubfeedPosition, maxNumMessages: MessageCount, waitMsec: DurationMsec}): Promise<SignedSubfeedMessage[]> {
        // Get some signed messages starting at position
        if (!this.#signedMessages) {
            /* istanbul ignore next */
            throw Error('_signedMessages is null. Perhaps getSignedMessages was called before subfeed was initialized.');
        }
        if (subfeedPositionToNumber(position) < this.#signedMessages.length) {
            // If we have some messages loaded into memory, let's return those!
            return this._getInMemorySignedMessages({position, maxNumMessages});
        }
        else if (subfeedPositionToNumber(position) === this.#signedMessages.length) {
            // We don't have any new messages in memory
            let signedMessages: SignedSubfeedMessage[] = [];
            if (!this.isWriteable()) {
                // If it's not locally writeable, then we should try to load messages from a remote node
                const remoteSignedMessages = await this.#remoteFeedManager.getSignedMessages({
                    feedId: this.#feedId,
                    subfeedHash: this.#subfeedHash,
                    position: subfeedPosition(this.#signedMessages.length),
                    maxNumMessages,
                    waitMsec
                });
                if ((remoteSignedMessages) && (remoteSignedMessages.length > 0)) {
                    // We found them! Let's first make sure that our position is still equal to this._signedMessages.length
                    if (subfeedPositionToNumber(position) === this.#signedMessages.length) {
                        // We found them! So we append them to local feed, and then call getSignedMessages() again. We should then return the appropriate number of signed messages.
                        this.appendSignedMessages(remoteSignedMessages);
                        return this._getInMemorySignedMessages({position, maxNumMessages});
                    }
                    else {
                        if (subfeedPositionToNumber(position) < this.#signedMessages.length) {
                            // we somehow got more signed messages. So let's go with those!
                            return this._getInMemorySignedMessages({position, maxNumMessages});
                        }
                        else {
                            /* istanbul ignore next */
                            throw Error('Unexpected problem. Position is now greater than signedMessages.length.')
                        }
                    }
                }
            }
            else if (durationMsecToNumber(waitMsec) > 0) {
                // If this is a writeable subfeed, and we have been instructed to wait, then let's just wait for a bit and maybe some new messages will arrive.

                await new Promise((resolve) => {
                    let resolved = false;
                    const listenerId = createListenerId();
                    this.#newMessageListeners.set(listenerId, () => {
                        if (resolved) return;
                        resolved = true;
                        this.#newMessageListeners.delete(listenerId);
                        // We have new messages! Call getSignedMessages again to retrieve them.
                        signedMessages = this._getInMemorySignedMessages({position, maxNumMessages});
                        resolve();    
                    });
                    setTimeout(() => {
                        if (resolved) return;
                        resolved = true;
                        this.#newMessageListeners.delete(listenerId);
                        resolve();
                    }, durationMsecToNumber(waitMsec));
                });
            }
            // Finally, return the signed messages that have been accumulated above.
            return signedMessages;
        }
        else {
            return [];
        }
    }
    // important that this is synchronous
    appendMessages(messages: SubfeedMessage[], {metaData} : {metaData: Object | undefined}) {
        if (!this.#signedMessages) {
            /* istanbul ignore next */
            throw Error('_signedMessages is null. Perhaps appendMessages was called before subfeed was initialized.');
        }
        if (!this.#privateKey) {
            /* istanbul ignore next */
            throw Error(`Cannot write to feed without private key: ${this.#privateKey}`);
        }
        let previousSignature;
        if (this.#signedMessages.length > 0) {
            previousSignature = this.#signedMessages[this.#signedMessages.length - 1].signature;
        }
        let messageNumber = this.#signedMessages.length;
        const signedMessages: SignedSubfeedMessage[] = [];
        for (let msg of messages) {
            let body = {
                message: msg,
                previousSignature,
                messageNumber,
                timestamp: nowTimestamp(),
                metaData: metaData ? metaData : undefined
            };
            const signedMessage: SignedSubfeedMessage = {
                body,
                signature: getSignatureJson(body as any as JSONObject, {publicKey: this.#publicKey, privateKey: this.#privateKey})
            };
            if (!verifySignatureJson(body as any as JSONObject, getSignatureJson(body as any as JSONObject, {publicKey: this.#publicKey, privateKey: this.#privateKey}), this.#publicKey)) {
                throw Error('Error verifying signature')
            }
            signedMessages.push(signedMessage);
            previousSignature = signedMessage.signature;
            messageNumber ++;
        }
        this.appendSignedMessages(signedMessages);
    }
    // important that this is synchronous!
    appendSignedMessages(signedMessages: SignedSubfeedMessage[]) {
        if (!this.#signedMessages) {
            /* istanbul ignore next */
            throw Error('_signedMessages is null. Perhaps appendSignedMessages was called before subfeed was initialized.');
        }
        if (signedMessages.length === 0)
            return;
        let previousSignature;
        if (this.#signedMessages.length > 0) {
            previousSignature = this.#signedMessages[this.#signedMessages.length - 1].signature;
        }
        let messageNumber = this.#signedMessages.length;
        const signedMessagesToAppend: SignedSubfeedMessage[] = []
        for (let signedMessage of signedMessages) {
            const body = signedMessage.body;
            const signature = signedMessage.signature;
            if (!verifySignatureJson(body as any as JSONObject, signature, this.#publicKey)) {
                throw Error(`Error verifying signature when appending signed message for: ${this.#feedId} ${this.#subfeedHash} ${signature}`);
            }
            if ((body.previousSignature || null) !== (previousSignature || null)) {
                throw Error(`Error in previousSignature when appending signed message for: ${this.#feedId} ${this.#subfeedHash} ${body.previousSignature} <> ${previousSignature}`);
            }
            if (body.messageNumber !== messageNumber) {
                throw Error(`Error in messageNumber when appending signed message for: ${this.#feedId} ${this.#subfeedHash} ${body.messageNumber} <> ${messageNumber}`);
            }
            previousSignature = signedMessage.signature;
            messageNumber ++;
            this.#signedMessages.push(signedMessage);
            signedMessagesToAppend.push(signedMessage)
        }
        this.#localFeedManager.appendSignedMessagesToSubfeed(this.#feedId, this.#subfeedHash, signedMessagesToAppend)

        this.#newMessageListeners.forEach((listener) => {
            listener()
        })
    }
    async getAccessRules(): Promise<SubfeedAccessRules | null> {
        return this.#accessRules
    }
    setAccessRules(accessRules: SubfeedAccessRules): void {
        if (!this.isWriteable()) {
            /* istanbul ignore next */
            throw Error(`Cannot set access rules for not writeable subfeed.`);
        }
        this.#localFeedManager.setSubfeedAccessRules(this.#feedId, this.#subfeedHash, accessRules)
        this.#accessRules = accessRules
    }
}

// const _subfeedHash = (subfeedName) => {
//     if (typeof(subfeedName) == 'string') {
//         if (subfeedName.startsWith('~')) {
//             assert(subfeedName.length === 41, `Invalid subfeed name: ${subfeedName}`);
//             validateSha1Hash(subfeedName.slice(1));
//             return subfeedName.slice(1);
//         }
//         return sha1sum(subfeedName);
//     }
//     else {
//         return sha1sum(JSONStringifyDeterministic(subfeedName));
//     }
// }



export default FeedManager;