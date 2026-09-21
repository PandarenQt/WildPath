import {MULTIPLAYER_MESSAGE_TYPES as MESSAGE, createResolutionSocketEnvelope} from "../../helpers/multiplayer-authority.mjs";
import {DISCLOSURE_CLASSIFICATIONS, DISCLOSURE_CODES, DISCLOSURE_TRANSPORTS} from "../../helpers/multiplayer-disclosure.mjs";

const QUERY_NAME = "wildpath.resolutionEnvelope";

/**
 * Real-Foundry proof of the targeted transport mechanism on a single GM client. This batch proves that
 * the registration, the real `system.wildpath` refusal, and the real `User#query` server relay work in
 * V14.367. It cannot prove cross-browser privacy: a single client is both sender and recipient. That
 * proof is the Level-5 three-case sentinel in docs/development/staged-movement-qa.md.
 */
export function registerMultiplayerDisclosureTests(quench) {
  quench.registerBatch("wildpath.multiplayer-disclosure", context => {
    const {describe,it,assert} = context;
    describe("Targeted disclosure transport in real Foundry V14 (single GM client)", function () {
      this.timeout(15000);
      const runtime = () => game.wildpath?.multiplayer;
      /** A harmless probe: a MOVEMENT_CONTINUATION whose boundary matches no movement is ignored by both coordinators. */
      const probe = (overrides={}) => createResolutionSocketEnvelope({
        messageType:MESSAGE.MOVEMENT_CONTINUATION, senderUserId:game.user.id, recipientUserId:game.user.id,
        resolutionId:`quench-disclosure:${foundry.utils.randomID()}`,
        payload:{boundary:{operationId:"quench-disclosure-probe"}, directive:"continue"}, ...overrides});
      const captureBroadcast = () => {
        const emitted = [];
        const listener = (name, ...args) => {if (name === "system.wildpath") emitted.push(args[0]);};
        game.socket.onAnyOutgoing(listener);
        return {emitted, stop:() => game.socket.offAnyOutgoing(listener)};
      };

      it("wires the disclosure-routed transport over the real socket adapter and the User#query adapter", function () {
        const transport = runtime()?.transport;
        assert.exists(transport,"WildPath multiplayer runtime must be registered");
        assert.equal(transport.type,"disclosure-routed-transport");
        assert.equal(transport.broadcast?.type,"foundry-v14-resolution-socket");
        assert.equal(transport.broadcast?.namespace,"system.wildpath");
        assert.equal(transport.targeted?.type,"foundry-v14-user-query");
        assert.equal(transport.targeted?.queryName,QUERY_NAME);
        assert.equal(transport.registered,true);
        assert.equal(game.system.socket,true,"the manifest must request the system socket namespace");
        assert.equal(typeof CONFIG.queries[QUERY_NAME],"function",`CONFIG.queries["${QUERY_NAME}"] must be registered`);
        assert.equal(game.user.hasPermission("QUERY_USER"),true,"the GM must be able to query users");
        assert.strictEqual(game.wildpath.resolutionTransport,transport);
      });

      it("the real broadcast adapter refuses private and unclassified envelopes without emitting on system.wildpath", async function () {
        const capture = captureBroadcast();
        try {
          const privateEnvelope = probe({recipientUserId:"someone-else"});
          assert.equal(privateEnvelope.disclosure,DISCLOSURE_CLASSIFICATIONS.PARTICIPANT_PRIVATE);
          const refused = await runtime().transport.broadcast.send(privateEnvelope);
          assert.equal(refused.ok,false);
          assert.equal(refused.code,DISCLOSURE_CODES.PRIVATE_PAYLOAD_REQUIRES_TARGETED_TRANSPORT);
          const unclassified = await runtime().transport.broadcast.send({...privateEnvelope, messageId:"quench-unclassified", disclosure:null});
          assert.equal(unclassified.ok,false);
          assert.equal(unclassified.code,DISCLOSURE_CODES.UNCLASSIFIED_DISCLOSURE);
          const routed = await runtime().transport.send({...privateEnvelope, messageId:"quench-routed-private", recipientUserId:"someone-else"});
          assert.equal(routed.ok,false,"an unknown recipient cannot be reached, and the bus is never a fallback");
          assert.equal(routed.code,DISCLOSURE_CODES.TARGETED_RECIPIENT_UNAVAILABLE);
          assert.deepEqual(capture.emitted,[],"nothing may reach socket.emit on system.wildpath");
        } finally { capture.stop(); }
      });

      it("User#query relays a private envelope through the real server and acknowledges with a receipt", async function () {
        const capture = captureBroadcast();
        const observed = [];
        const unobserve = runtime().transport.observe(event => {if (event.direction === "incoming") observed.push(event);});
        try {
          const envelope = probe();
          const receipt = await game.user.query(QUERY_NAME,envelope,{timeout:5000});
          assert.equal(receipt?.ok,true,JSON.stringify(receipt));
          assert.equal(receipt.messageId,envelope.messageId);
          assert.equal(receipt.messageType,MESSAGE.MOVEMENT_CONTINUATION);
          assert.equal(receipt.receivedByUserId,game.user.id);
          const incoming = observed.find(event => event.envelope?.messageId === envelope.messageId);
          assert.exists(incoming,"the transport must dispatch the relayed envelope to the coordinators");
          assert.equal(incoming.transport,DISCLOSURE_TRANSPORTS.TARGETED);
          assert.equal(incoming.attestedSenderUserId,game.user.id,"the handler sees the server-attested querying user");
          assert.deepEqual(capture.emitted,[],"a targeted envelope never crosses system.wildpath");
        } finally { unobserve(); capture.stop(); }
      });

      it("the query handler rejects a forged sender identity and a misaddressed recipient", async function () {
        const attempt = async envelope => {
          try { await game.user.query(QUERY_NAME,envelope,{timeout:5000}); return null; }
          catch (error) { return error?.message ?? String(error); }
        };
        const forged = await attempt(probe({senderUserId:"not-the-querying-user"}));
        assert.isString(forged,"a forged senderUserId must be rejected by the recipient");
        assert.include(forged,DISCLOSURE_CODES.DISCLOSURE_SENDER_MISMATCH);
        const misaddressed = await attempt(probe({recipientUserId:"someone-else"}));
        assert.isString(misaddressed,"an envelope addressed to another user must be rejected by the recipient");
        assert.include(misaddressed,DISCLOSURE_CODES.DISCLOSURE_RECIPIENT_MISMATCH);
        const unclassified = await attempt({...probe(), disclosure:null});
        assert.isString(unclassified);
        assert.include(unclassified,DISCLOSURE_CODES.UNCLASSIFIED_DISCLOSURE);
      });
    });
  }, {displayName:"WILDPATH: Multiplayer Disclosure",preSelected:false});
}
