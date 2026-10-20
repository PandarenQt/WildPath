/**
 * Language text in Foundry (helpers/languages.mts): `[elvish]…[/elvish]` in chat, journals, descriptions and speech
 * bubbles is a passage in that language, rendered on each client for its reader. A GM reads it plainly, marked; so
 * does whoever wrote or says it; anyone else reads it plainly only when their character (or a creature they control)
 * understands it, and otherwise in its script. In-character chat with no tag is Common.
 */
import { LANGUAGE_SCRIPT, SCRIPTS, TAGGABLE_LANGUAGES, parseLanguageFonts, speakerOf, transliterate, understands } from "../helpers/languages.mjs";
const ENRICHER_ID = "wildpath-language";
const TAG = new RegExp(`\\[(${TAGGABLE_LANGUAGES.join("|")})\\]([\\s\\S]*?)\\[\\/\\1\\]`, "gi");
const globals = () => globalThis;
/** The enricher, the default Common, the editor's Language menu and the GM's fonts setting. Called in `init`. */
export function registerLanguages() {
    const { game, CONFIG, Hooks } = globals();
    game.settings.register("wildpath", "languageFonts", { name: "WILDPATH.LANGUAGES.Fonts", hint: "WILDPATH.LANGUAGES.FontsHint",
        scope: "world", config: true, type: String, default: "" });
    CONFIG.TextEditor.enrichers.push({ id: ENRICHER_ID, pattern: TAG,
        enricher: (match) => {
            const span = document.createElement("span");
            span.classList.add("wildpath-language");
            span.dataset.language = String(match[1]).toLowerCase();
            span.textContent = match[2] ?? "";
            return span;
        },
        onRender: (element) => {
            const span = element.querySelector(".wildpath-language");
            if (span)
                renderLanguage(span, span.dataset.language ?? "", readingOf(element));
        } });
    Hooks.on("renderChatMessageHTML", (message, html) => defaultCommonMessage(message, html));
    Hooks.on("chatBubbleHTML", (token, html, _text, options) => defaultCommonBubble(token, html, options));
    Hooks.on("getProseMirrorMenuDropDowns", (_menu, menus) => {
        menus.wildpathLanguage = { title: "WILDPATH.LANGUAGES.Tag", cssClass: "wildpath-languages", icon: '<i class="fa-solid fa-language fa-fw"></i>',
            entries: TAGGABLE_LANGUAGES.map(key => ({ action: `wildpath-language-${key}`, title: `WILDPATH.LANGUAGES.${key}`,
                cmd: (state, dispatch) => {
                    const { from, to } = state.selection;
                    const text = state.doc.textBetween(from, to);
                    dispatch(state.tr.insertText(`[${key}]${text}[/${key}]`, from, to));
                    return true;
                } })) };
    });
}
/** Where a passage stands: a chat message (spoken by its speaker), a speech bubble (by its Token), else written. */
function readingOf(element) {
    const { game, canvas } = globals();
    const messageId = element.closest("[data-message-id]")?.dataset.messageId;
    const message = messageId ? game.messages.get(messageId) : null;
    if (message)
        return messageReading(message);
    const tokenId = element.closest(".chat-bubble[data-token-id]")?.dataset.tokenId;
    const token = tokenId ? canvas?.tokens?.get(tokenId)?.document : null;
    if (token)
        return { spoken: true, speakerActor: token.actor, speakerToken: token, own: token.isOwner === true };
    return { spoken: false };
}
function messageReading(message) {
    const { game } = globals();
    const speaker = message.speaker ?? {};
    const speakerToken = speaker.token ? game.scenes.get(speaker.scene)?.tokens?.get(speaker.token) ?? null : null;
    return { spoken: true, speakerActor: message.speakerActor ?? null, speakerToken, own: message.isAuthor === true };
}
/** The creatures this user reads as: its character, and the creatures whose Tokens it controls. */
function readers() {
    const { game, canvas } = globals();
    return [...new Set([game.user.character, ...(canvas?.tokens?.controlled ?? []).map((token) => token.actor)].filter(Boolean))];
}
/** How far a reader's Token stands from the speaking Token, in feet, on the same Scene; else null. */
function distanceTo(reader, speakerToken) {
    const scene = speakerToken?.parent;
    const token = scene ? [...scene.tokens].find((entry) => (entry.actor === reader) || (entry.actorLink && (entry.actorId === reader.id))) : null;
    if (!token)
        return null;
    try {
        return Number(scene.grid.measurePath([token.getCenterPoint(), speakerToken.getCenterPoint()]).distance);
    }
    catch {
        return null;
    }
}
/**
 * A passage in `language` (its element) as this client's reader reads it: plainly, or in its script (each text node
 * transliterated), or in the GM's font for it (`languageFonts`: the Latin text in that font).
 */
export function renderLanguage(element, language, reading) {
    const { game } = globals();
    if (element.dataset.languageRendered)
        return;
    element.dataset.languageRendered = "true";
    element.dataset.tooltip = game.i18n.localize(`WILDPATH.LANGUAGES.${language}`);
    if (game.user.isGM) {
        element.classList.add("wildpath-language-gm");
        return;
    }
    const speaker = speakerOf(reading.speakerActor);
    const read = reading.own || readers().some(reader => understands({ reader: speakerOf(reader), language, spoken: reading.spoken, speaker,
        distance: reading.spoken ? distanceTo(reader, reading.speakerToken) : null }));
    if (read) {
        element.classList.add("wildpath-language-known");
        return;
    }
    delete element.dataset.tooltip;
    element.classList.add("wildpath-language-foreign");
    const font = parseLanguageFonts(game.settings.get("wildpath", "languageFonts"))[language];
    if (font) {
        element.style.fontFamily = `"${font}"`;
        return;
    }
    const script = LANGUAGE_SCRIPT[language];
    if (!script || !SCRIPTS[script])
        return;
    element.dataset.script = script;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode())
        node.nodeValue = transliterate(node.nodeValue ?? "", script);
}
/** In-character chat with no language tag is Common (emotes, rolls and cards are not). */
function defaultCommonMessage(message, html) {
    const { CONST } = globals();
    if ((message.style !== CONST.CHAT_MESSAGE_STYLES.IC) || message.rolls?.length || !message.speakerActor)
        return;
    const content = html.querySelector(".message-content");
    if (!content || content.querySelector(`[enricher="${ENRICHER_ID}"]`))
        return;
    renderLanguage(content, "common", messageReading(message));
}
/** A speech bubble with no language tag is Common too (not an emote). */
function defaultCommonBubble(token, html, options) {
    if ((options?.cssClasses ?? []).includes("emote"))
        return;
    const content = html.querySelector(".bubble-content");
    if (!content || content.querySelector(`[enricher="${ENRICHER_ID}"]`))
        return;
    renderLanguage(content, "common", { spoken: true, speakerActor: token.actor, speakerToken: token.document, own: token.document?.isOwner === true });
}
