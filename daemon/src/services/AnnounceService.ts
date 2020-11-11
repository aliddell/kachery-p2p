import { action } from "../common/action"
import { TIMEOUTS } from "../common/constants"
import GarbageMap from "../common/GarbageMap"
import { RequestTimeoutError, sleepMsec, sleepMsecNum } from "../common/util"
import { HttpPostJsonError } from "../external/real/httpRequests"
import { ChannelName, DurationMsec, durationMsecToNumber, elapsedSince, NodeId, nowTimestamp, scaledDurationMsec, Timestamp, zeroTimestamp } from "../interfaces/core"
import { AnnounceRequestData, isAnnounceResponseData } from "../interfaces/NodeToNodeRequest"
import KacheryP2PNode from "../KacheryP2PNode"
import RemoteNode, { SendRequestMethod } from "../RemoteNode"
import RemoteNodeManager from "../RemoteNodeManager"

export default class AnnounceService {
    #node: KacheryP2PNode
    #remoteNodeManager: RemoteNodeManager
    #halted = false
    #announceHistoryTimestamps = new GarbageMap<NodeId, Timestamp>(scaledDurationMsec(30 * 60 * 1000))
    constructor(node: KacheryP2PNode, private opts: {announceBootstrapIntervalMsec: DurationMsec, announceToIndividualNodeIntervalMsec: DurationMsec}) {
        this.#node = node
        this.#remoteNodeManager = node.remoteNodeManager()
        // announce self when a new node-channel has been added
        this.#remoteNodeManager.onNodeChannelAdded(async (remoteNodeId: NodeId, channelName: ChannelName) => {
            if (this.#halted) return
            // check if we can send message to node, if not, delay a bit
            let numPasses = 0
            while (!this.#remoteNodeManager.canSendRequestToNode(remoteNodeId, 'default')) {
                if (numPasses > 3) return
                numPasses ++
                await sleepMsec(scaledDurationMsec(1000))
            }
            if (this.#node.channelNames().includes(channelName)) { // only if we belong to this channel

                /////////////////////////////////////////////////////////////////////////
                action('announceToNewNode', {context: 'AnnounceService', remoteNodeId, channelName}, async () => {
                    await this._announceToNode(remoteNodeId, channelName)
                }, null)
                /////////////////////////////////////////////////////////////////////////
            }

        })

        this.#remoteNodeManager.onBootstrapNodeAdded((bootstrapNodeId) => {
            if (this.#halted) return
            const channelNames = this.#node.channelNames()
            for (let channelName of channelNames) {
                /////////////////////////////////////////////////////////////////////////
                action('announceToNewBootstrap', {context: 'AnnounceService', bootstrapNodeId, channelName}, async () => {
                    await this._announceToNode(bootstrapNodeId, channelName)
                }, null)
                /////////////////////////////////////////////////////////////////////////
            }
        })

        this.#node.onProxyConnectionToServer(() => {
            if (this.#halted) return
            this._announceToAllBootstrapNodes()
        })

        this._start()
    }
    stop() {
        this.#halted = true
    }
    async _announceToNode(remoteNodeId: NodeId, channelName: ChannelName) {
        let numPasses = 0
        while (!this.#remoteNodeManager.canSendRequestToNode(remoteNodeId, 'default')) {
            numPasses ++
            if (numPasses > 3) return
            await sleepMsec(scaledDurationMsec(1500))
        }
        const requestData: AnnounceRequestData = {
            requestType: 'announce',
            channelNodeInfo: this.#node.getChannelNodeInfo(channelName)
        }
        let method: SendRequestMethod = 'prefer-udp' // we prefer to send via udp so that we can discover our own public udp address when we get the response
        let responseData
        try {
            responseData = await this.#remoteNodeManager.sendRequestToNode(remoteNodeId, requestData, {timeoutMsec: TIMEOUTS.defaultRequest, method})
        }
        catch(err) {
            if ((err instanceof HttpPostJsonError) || (err instanceof RequestTimeoutError)) {
                // the node is probably not connected
                return
            }
            else {
                throw err
            }
        }
        if (!isAnnounceResponseData(responseData)) {
            throw Error('Unexpected.')
        }
        if (!responseData.success) {
            // what should we do here? remove the node?
            console.warn(`Response error for announce: ${responseData.errorMessage}`)
        }
    }
    async _announceToAllBootstrapNodes() {
        const bootstrapNodes: RemoteNode[] = this.#remoteNodeManager.getBootstrapRemoteNodes()
        const channelNames = this.#node.channelNames()
        for (let bootstrapNode of bootstrapNodes) {
            for (let channelName of channelNames) {

                /////////////////////////////////////////////////////////////////////////
                await action('announceToNode', {context: 'AnnounceService', bootstrapNodeId: bootstrapNode.remoteNodeId(), channelName}, async () => {
                    await this._announceToNode(bootstrapNode.remoteNodeId(), channelName)
                }, null);
                /////////////////////////////////////////////////////////////////////////

            }
        }
    }
    async _start() {
        await sleepMsecNum(2) // important for tests
        // Announce self other nodes in our channels and to bootstrap nodes
        let lastBootstrapAnnounceTimestamp: Timestamp = zeroTimestamp()
        let lastIndividualNodeAnnounceTimestamp: Timestamp = zeroTimestamp()
        while (true) {
            if (this.#halted) return
            // periodically announce to bootstrap nodes
            const elapsedSinceLastBootstrapAnnounce = elapsedSince(lastBootstrapAnnounceTimestamp)
            if (elapsedSinceLastBootstrapAnnounce > durationMsecToNumber(this.opts.announceBootstrapIntervalMsec)) {
                await this._announceToAllBootstrapNodes()
                lastBootstrapAnnounceTimestamp = nowTimestamp()
            }
            
            
            const elapsedSinceLastIndividualNodeAnnounce = elapsedSince(lastIndividualNodeAnnounceTimestamp)
            if (elapsedSinceLastIndividualNodeAnnounce > durationMsecToNumber(this.opts.announceToIndividualNodeIntervalMsec)) {
                // for each channel, choose a node and announce to that node
                const channelNames = this.#node.channelNames()
                for (let channelName of channelNames) {
                    let nodes = this.#remoteNodeManager.getRemoteNodesInChannel(channelName)
                    if (nodes.length > 0) {
                        var individualNode = selectNode(nodes, this.#announceHistoryTimestamps)
                        this.#announceHistoryTimestamps.set(individualNode.remoteNodeId(), nowTimestamp())

                        /////////////////////////////////////////////////////////////////////////
                        await action('announceToIndividualNode', {context: 'AnnounceService', remoteNodeId: individualNode.remoteNodeId(), channelName}, async () => {
                            await this._announceToNode(individualNode.remoteNodeId(), channelName)
                        }, null)
                        /////////////////////////////////////////////////////////////////////////

                    }
                }
                lastIndividualNodeAnnounceTimestamp = nowTimestamp()
            }
            await sleepMsec(scaledDurationMsec(500), () => {return !this.#halted})
        }
    }
}

// thanks: https://gist.github.com/engelen/fbce4476c9e68c52ff7e5c2da5c24a28
function argMax(array: number[]) {
    if (array.length === 0) throw Error('Unexpected')
    return array.map((x, i) => [x, i]).reduce((r, a) => (a[0] > r[0] ? a : r))[1];
}

const selectNode = (nodes: RemoteNode[], historyTimestamps: GarbageMap<NodeId, Timestamp>): RemoteNode => {
    const n = nodes[0]
    if (!n) throw Error('Unexpected')
    const timestamps: Timestamp[] = nodes.map(n => (historyTimestamps.getWithDefault(n.remoteNodeId(), zeroTimestamp())))
    const elapsedTimes = timestamps.map(ts => (elapsedSince(ts)))
    const ind = argMax(elapsedTimes)
    return nodes[ind]
}