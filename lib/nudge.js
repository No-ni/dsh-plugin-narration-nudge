/**
 * Pure decision core for the narration nudge.
 *
 * Everything here is a plain function over plain objects: no Cordis context, no
 * Node globals, no I/O. The host half (index.js) owns the wiring, which keeps
 * the rule itself directly unit-testable and the risky part - touching a live
 * conversation - confined to one place.
 *
 * The contract this module encodes is deliberately narrow: a *step* is silent
 * when the assistant message that carried the tool call held no visible text.
 * Silent steps are counted, and one reminder is emitted per silent step, capped
 * per turn, worded once gently and then firmly.
 *
 * @module dsh-plugin-narration-nudge/nudge
 */

/** Wording languages with built-in templates. */
export const LANGUAGES = ['zh', 'en']

/** Built-in contract sizes; 'off' means this plugin adds nothing to the head. */
export const CONTRACTS = ['off', 'short', 'full']

const DEFAULT_THRESHOLD = 1
const DEFAULT_MAX_PER_TURN = 2
const DEFAULT_LANGUAGE = 'zh'
const DEFAULT_CONTRACT = 'off'
const MAX_TRACKED_SESSIONS = 200

/** Coerce a count to a positive integer, or fall back. */
function positiveInt(value, fallback) {
	const n = Number(value)
	return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback
}

/**
 * Turn loader-provided config into a fully resolved one.
 * @param raw - config as authored in cordis.patch.yml (may be undefined).
 * @returns resolved config with every field defaulted and clamped.
 */
export function resolveConfig(raw) {
	const config = raw !== null && typeof raw === 'object' ? raw : {}
	return {
		enabled: config.enabled !== false,
		threshold: positiveInt(config.threshold, DEFAULT_THRESHOLD),
		maxPerTurn: positiveInt(config.maxPerTurn, DEFAULT_MAX_PER_TURN),
		language: LANGUAGES.includes(config.language) ? config.language : DEFAULT_LANGUAGE,
		contract: CONTRACTS.includes(config.contract) ? config.contract : DEFAULT_CONTRACT
	}
}

/**
 * Classify one assistant message for narration purposes.
 * @param message - the assistant message payload from a session event.
 * @returns 'silent-tool' (called a tool, said nothing), 'narrated-tool'
 *   (called a tool and spoke), 'narrated' (spoke, no tool), or 'empty'.
 */
export function classifyAssistantMessage(message) {
	const content = Array.isArray(message?.content) ? message.content : []
	const hasText = content.some(
		(block) => block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== ''
	)
	const hasToolCall = content.some(
		(block) => block?.type === 'tool-call' || block?.type === 'tool_call' || block?.type === 'function_call'
	)
	if (!hasToolCall) return hasText ? 'narrated' : 'empty'
	return hasText ? 'narrated-tool' : 'silent-tool'
}

/** A fresh per-session state record. */
export function initialState() {
	return {
		turn: 0,
		/** Consecutive silent steps, cleared as soon as the model speaks. */
		streak: 0,
		/** Reminders emitted in the current turn. */
		nudgesThisTurn: 0,
		/** Reminders emitted in this session, across turns. */
		nudgedTotal: 0,
		/** Whether a silent step is waiting for its reminder. */
		armed: false
	}
}

/** Create the per-session state map. */
export function createStates() {
	return new Map()
}

/**
 * Read a session's state, keeping the map ordered as a cheap LRU.
 * @param states - the map from createStates.
 * @param key - session id.
 * @returns the mutable state record for that session.
 */
export function stateFor(states, key) {
	const existing = states.get(key)
	if (existing !== undefined) {
		states.delete(key)
		states.set(key, existing)
		return existing
	}
	const state = initialState()
	states.set(key, state)
	while (states.size > MAX_TRACKED_SESSIONS) {
		const oldest = states.keys().next().value
		if (oldest === undefined) break
		states.delete(oldest)
	}
	return state
}

/**
 * Reset the per-turn counters. Deliberately does *not* reset the session-level
 * escalation counter: a model that drifts twice should hear it firmly the
 * second time.
 * @param state - session state.
 * @returns the same state, for call chaining.
 */
export function beginTurn(state) {
	state.turn += 1
	state.nudgesThisTurn = 0
	state.streak = 0
	state.armed = false
	return state
}

/**
 * Fold one classified assistant message into the state.
 * @param state - session state.
 * @param kind - return value of classifyAssistantMessage.
 * @returns the same state, for call chaining.
 */
export function noteAssistant(state, kind) {
	if (kind === 'silent-tool') {
		state.streak += 1
		state.armed = true
	} else if (kind === 'narrated-tool' || kind === 'narrated') {
		state.streak = 0
		state.armed = false
	}
	return state
}

/**
 * Decide whether this tool result should carry a reminder.
 * @param state - session state.
 * @param config - resolved config.
 * @returns whether to emit.
 */
export function shouldNudge(state, config) {
	if (config.enabled !== true) return false
	if (state.armed !== true) return false
	if (state.streak < config.threshold) return false
	return state.nudgesThisTurn < config.maxPerTurn
}

/**
 * Record that a reminder was emitted, disarming the current step.
 * @param state - session state.
 * @returns the same state, for call chaining.
 */
export function markNudged(state) {
	state.armed = false
	state.nudgesThisTurn += 1
	state.nudgedTotal += 1
	return state
}

/**
 * Wording for one reminder.
 * @param language - 'zh' or 'en'.
 * @param total - how many reminders this session has seen, including this one.
 * @param streak - consecutive silent steps at the time of writing.
 * @returns the reminder text.
 */
export function nudgeText(language, total, streak) {
	if (language === 'en') {
		if (total <= 1) {
			return 'Narration reminder: this step called a tool without any visible reply text. Before each further tool call, write one or two sentences of ordinary assistant text about what you just finished and what comes next - the user cannot see your reasoning.'
		}
		return (
			'Narration reminder (' + total + 'x so far): this turn has now run ' + streak +
			' tool steps without visible reply text. The user only sees tool rows, not your judgment or progress. Before every further tool call, write one or two sentences of ordinary assistant text.'
		)
	}
	if (total <= 1) {
		return '过程叙述提醒：这一步在调用工具之前没有写任何正文。接下来每次调用工具之前，先用 1-2 句正文说明你刚做了什么、接下来要做什么——用户看不到你的思考，只能靠这些正文跟上进度。'
	}
	return (
		'过程叙述提醒（本次会话第 ' + total + ' 次）：本轮已连续 ' + streak +
		' 步只调工具、没有正文叙述。用户只能看到工具行，看不到你的判断和进度；之后每次调用工具前，先写 1-2 句正文。'
	)
}

/**
 * Text for the optional static contract section.
 *
 * This is a **constant**: it never depends on session state, which is the whole
 * point - a head that does not change cannot invalidate the prefix cache.
 * @param language - 'zh' or 'en'.
 * @param contract - 'short' or 'full'.
 * @returns the section body.
 */
export function contractText(language, contract) {
	const short = contract === 'short'
	if (language === 'en') {
		if (short) {
			return '## Narration\n\nNarrate while you work: before each tool call, write one or two sentences of ordinary assistant text about what you just finished and what comes next. Never run a whole turn of tool calls in silence.'
		}
		return [
			'## Narration',
			'',
			'Narrate while you work. The user only sees scattered tool rows, not your working state:',
			'',
			'- Open with 1-2 sentences: how you read the message, what you will do, and the first step.',
			'- Between tool-call batches, add 1-2 sentences about what just finished and what comes next.',
			'- Never chain tool calls in complete silence.',
			'- Write it as ordinary reply text, never inside reasoning.'
		].join('\n')
	}
	if (short) {
		return '## 过程叙述\n\n干活时边做边说：每次调用工具之前，先用 1-2 句正文说明你刚做了什么、接下来要做什么。不要整轮只调工具、不说话。'
	}
	return [
		'## 过程叙述（边做边说）',
		'',
		'用户只能看到零散的工具行，看不到你的工作状态，请在过程里主动说明：',
		'',
		'- 收到新消息后、调用工具之前，先用 1-2 句正文说明你怎么理解、准备怎么做、第一步是什么。',
		'- 每批工具调用结束后、开始下一批之前，写 1-3 句刚完成什么、接下来做什么。',
		'- 不要出现「工具调用 → 工具调用」的全程静默。',
		'- 写在正常回复正文里，不要写进思考内容。'
	].join('\n')
}
