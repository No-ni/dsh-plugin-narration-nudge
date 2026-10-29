/**
 * Narration nudge: a tail-side supervision for process narration.
 *
 * Why this exists
 * ---------------
 * The usual way to make an agent narrate its work is a system-prompt section
 * plus an "you forgot to narrate" line that gets appended to that section when
 * a step is silent. That line sits in the *head* of every request, so adding or
 * removing it invalidates the provider's prefix cache for the whole
 * conversation - tens of thousands of tokens re-prefilled per flip.
 *
 * This plugin keeps the supervision and moves the text: the reminder is
 * delivered as an extra user-side context on the tool result that just
 * finished, so it lands at the *tail* of the conversation. Nothing that was
 * already sent ever changes, and the prefix cache survives.
 *
 * The head is only touched when 'contract' is explicitly enabled, and then with
 * a constant string that can never vary between requests.
 *
 * @module dsh-plugin-narration-nudge
 */

import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import {
	beginTurn,
	classifyAssistantMessage,
	contractText,
	createStates,
	markNudged,
	noteAssistant,
	nudgeText,
	resolveConfig,
	shouldNudge,
	stateFor
} from './nudge.js'

/** Cordis plugin name. */
export const name = 'narration-nudge'

/** Config schema shown by the plugin manager. */
export const Config = z.object({
	enabled: z.boolean().default(true),
	threshold: z.number().default(1),
	maxPerTurn: z.number().default(2),
	language: z.string().default('zh'),
	contract: z.string().default('off')
})

/** Source stamped on every injected reminder; an unlabeled context would read as a user prompt. */
const REMINDER_SOURCE = { kind: 'narration-nudge' }

/** Deep-freeze a value in place. */
function deepFreeze(value) {
	if (value !== null && typeof value === 'object') {
		for (const nested of Object.values(value)) deepFreeze(nested)
		Object.freeze(value)
	}
	return value
}

/**
 * Build one immutable user-role message.
 * @param input - content and source for the message.
 * @returns a frozen message with a fresh identity.
 */
function createUserMessage(input) {
	return deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))
}

/** Read the session key out of whatever the host hands us. */
function keyOf(session) {
	if (typeof session === 'string' && session !== '') return session
	if (session !== null && typeof session === 'object' && typeof session.id === 'string' && session.id !== '') {
		return session.id
	}
	return undefined
}

/**
 * Install the plugin.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param rawConfig - config from the profile patch, resolved and clamped here.
 */
export function apply(ctx, rawConfig) {
	const config = resolveConfig(rawConfig)
	if (config.enabled === false) return

	const states = createStates()

	const log = (message) => {
		try {
			const logger = ctx.logger?.('narration-nudge')
			if (typeof logger?.info === 'function') logger.info(message)
		} catch {
			// logging must never break the turn
		}
	}

	// Track the session's narration behaviour. A silent step is one whose
	// assistant message carried a tool call and no visible text.
	ctx.on('session/event', (session, event) => {
		const key = keyOf(session)
		if (key === undefined || event === null || typeof event !== 'object') return
		const state = stateFor(states, key)
		if (event.type === 'turn/start') {
			beginTurn(state)
			return
		}
		if (event.type === 'assistant/message') {
			noteAssistant(state, classifyAssistantMessage(event.data?.message))
			return
		}
		if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
			state.streak = 0
			state.armed = false
		}
	})

	// Deliver the reminder on the tool result that just finished: it becomes an
	// additional context at the end of the conversation instead of a change to
	// the system prompt.
	ctx.on('tools/post-execute', async (exec, _result, next) => {
		const downstream = await next()
		const key = keyOf(exec?.agent?.session)
		if (key === undefined) return downstream
		const state = stateFor(states, key)
		if (!shouldNudge(state, config)) return downstream
		if (downstream === null || downstream === undefined) return downstream

		const streak = state.streak
		const total = state.nudgedTotal + 1
		markNudged(state)

		const reminder = createUserMessage({
			content: [{ type: 'text', text: nudgeText(config.language, total, streak) }],
			source: { ...REMINDER_SOURCE, form: 'notice', summary: 'silent step x' + streak }
		})
		log('nudge #' + total + ' streak=' + streak + ' session=' + key)
		return { ...downstream, additionalContexts: [reminder, ...(downstream.additionalContexts ?? [])] }
	})

	// Optional static contract. Constant by construction: a head section that
	// never varies cannot invalidate the prefix cache.
	if (config.contract !== 'off') {
		const text = contractText(config.language, config.contract)
		const register = () =>
			ctx.systemPrompt.section({
				name: 'narration-nudge-contract',
				order: 8950,
				interpolate: false,
				text: () => text
			})
		if (typeof ctx.effect === 'function') ctx.effect(register, 'narration-nudge.contract()')
		else register()
	}
}
