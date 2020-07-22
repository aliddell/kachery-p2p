import { randomString, sleepMsec } from "../common/util.js";

class SmartySwarmConnection {
    constructor(swarmConnection) {
        this._swarmConnection = swarmConnection;
        this._optimalRoutesToPeers = {}; // {[peerId]: {timestamp: ..., optimalRoute: ...}}

        this._swarmConnection.onPeerRequest(({fromNodeId, requestBody, onResponse, onError, onFinished}) => {
            const type0 = requestBody.type;
            if (type0 === 'routeLatencyTest') {
                this._handleRouteLatencyTest({fromNodeId, requestBody, onResponse, onError, onFinished});
            }
        });

        this._start();
    }
    async which_route_should_i_use_to_send_a_message_to_this_peer(peerId, {calculateIfNeeded}) {
        for (let passnum = 1; passnum <= 2; passnum++) {
            if (peerId in this._optimalRoutesToPeers) {
                const {route, timestamp} = this._optimalRoutesToPeers[peerId].route;
                const elapsed0 = (new Date() - timestamp);
                if ((elapsed0 < 10000) || (!calculateIfNeeded)) {
                    const firstNodeId = route[0];
                    const pc = this._swarmConnection.peerConnection(firstNodeId);
                    if ((pc) && (pc.hasWebsocketConnection())) {
                        return route;
                    }
                    else {
                        delete this._optimalRoutesToPeers[peerId];
                    }
                }
            }
            if (passnum === 1) {
                if (!calculateIfNeeded) return null;
                const optimalRoute = await this._estimateOptimalRouteToPeer(peerId);
                if (optimalRoute) {
                    this._optimalRoutesToPeers[peerId] = {
                        route: optimalRoute,
                        timestamp: new Date()
                    };
                }
            }
        }
        return null;
    }

    async _estimateOptimalRouteToPeer(peerId) {
        const peerIds = this._swarmConnection.peerIds();
        const candidatePeerIds = peerIds.filter(peerId => {
            const pc = this._swarmConnection.peerConnection(pc);
            return ((pc) && (pc.hasWebsocketConnection()));
        })
        const timings = {};
        const routes = {};
        const testCandidate = (candidatePeerId) => {
            const testData = randomString(1000);
            const requestBody = {
                type: 'routeLatencyTest',
                toPeerId: peerId,
                testData,
                avoid: [this._swarmConnection.nodeId()]
            };
            const timer = new Date();
            const req = this._swarmConnection.makeRequestToPeer(candidatePeerId, requestBody, {timeout: 5000});
            let finished = false;
            let gotCorrectResponse = false;
            let responseRoute = null;
            req.onResponse(responseBody => {
                if (finished) return;
                if (responseBody.testData === testData) {
                    gotCorrectResponse = true;
                    responseRoute = [this._swarmConnection.nodeId(), ...responseBody.route];
                }
            });
            req.onError(errorString => {
                if (finished) return;
                finished = true;
                timings[candidatePeerId] = null;
                routes[candidatePeerId] = null;
            })
            req.onFinished(() => {
                if (finished) return;
                finished = true;
                if (gotCorrectResponse) {
                    const elapsed = (new Date()) - timer;
                    timings[candidatePeerId] = elapsed;
                    routes[candidatePeerId] = responseRoute;
                }
                else {
                    timings[candidatePeerId] = null;
                    routes[candidatePeerIds] = null;
                }
            });
        }
        for (let candidatePeerId of candidatePeerIds) {
            testCandidate(candidatePeerId)
        }
        while (true) {
            function getBestRouteFromTimings() {
                let bestTiming = null;
                let bestCandidatePeerId = null;
                for (let candidatePeerId of candidatePeerIds) {
                    const timing0 = timings[candidatePeerId];
                    if (timing0 !== null) {
                        if ((bestTiming === null) || (timing0 < bestTiming)) {
                            bestTiming = timing0;
                            bestCandidatePeerId = candidatePeerId;
                        }
                    }
                }
                if (bestCandidatePeerId === null)
                    return null;
                return routes[bestCandidatePeerId];
            }
            const bestRoute = getBestRouteFromTimings();
            if (bestRoute) {
                return bestRoute;
            }
            if (Object.keys(timings).length === candidatePeerIds.length)
                return null;
            sleepMsec(10);
        }
    }

    async _handleRouteLatencyTest({fromNodeId, requestBody, onResponse, onError, onFinished}) {
        const {toPeerId, testData, avoid} = requestBody;
        if (toPeerId === this._swarmConnection.nodeId()) {
            onResponse({
                route: [],
                testData
            });
            onFinished();
            return;
        }
        // for now we only test routes of length 2
        // in future we can use the already-determined optimal route (and checking it does not contain the avoid stuff)
        const pc = this._swarmConnection.peerConnection(toPeerId);
        if ((pc) && (pc.hasWebsocketConnection())) {
            const req = this._swarmConnection.makeRequestToPeer(toPeerId, {
                toPeerId,
                testData,
                avoid: [...avoid, this._swarmConnection.nodeId()]
            });
            req.onResponse(responseBody => {
                onResponse({
                    route: [toPeerId, ...responseBody.route],
                    testData: responseBody.testData
                })
            });
            req.onError(onError);
            req.onFinished(onFinished);
            return;
        }
    }

    async _start() {

    }
}

export default SmartySwarmConnection;