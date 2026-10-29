import test from 'node:test'
import assert from 'node:assert/strict'
import {
	beginTurn,
	classifyAssistantMessage,
	contractText,
	createStates,
	initialState,
	markNudged,
	noteAssistant,
	nudgeText,
	resolveConfig,
	shouldNudge,
	stateFor
} from '../lib/nudge.js'

test('resolveConfig fills defaults', () => {
	const config = resolveConfig(undefined)
	assert.deepEqual(config, { enabled: true, threshold: 1, maxPerTurn: 2, language: 'zh', contract: 'off' })
})

test('resolveConfig clamps and rejects unknown values', () => {
	const config = resolveConfig({ enabled: false, threshold: 0, maxPerTurn: -3, language: 'fr', contract: 'huge' })
	assert.equal(config.enabled, false)
	assert.equal(config.threshold, 1)
	assert.equal(config.maxPerTurn, 2)
	assert.equal(config.language, 'zh')
	assert.equal(config.contract, 'off')
})

test('classifyAssistantMessage separates silent tool steps from narrated ones', () => {
	assert.equal(classifyAssistantMessage({ content: [{ type: 'reasoning', text: '...' }, { type: 'tool-call' }] }), 'silent-tool')
	assert.equal(classifyAssistantMessage({ content: [{ type: 'text', text: 'ok' }, { type: 'tool-call' }] }), 'narrated-tool')
	assert.equal(classifyAssistantMessage({ content: [{ type: 'text', text: 'done' }] }), 'narrated')
	assert.equal(classifyAssistantMessage({ content: [{ type: 'reasoning', text: '...' }] }), 'empty')
	assert.equal(classifyAssistantMessage({ content: [{ type: 'text', text: '   ' }, { type: 'tool-call' }] }), 'silent-tool')
})

test('silent steps arm the reminder and speaking disarms it', () => {
	const state = initialState()
	noteAssistant(state, 'silent-tool')
	assert.equal(state.streak, 1)
	assert.equal(state.armed, true)
	noteAssistant(state, 'narrated-tool')
	assert.equal(state.streak, 0)
	assert.equal(state.armed, false)
})

test('shouldNudge respects threshold, arm state and the per-turn cap', () => {
	const config = resolveConfig({ threshold: 2, maxPerTurn: 1 })
	const state = initialState()
	state.armed = true
	state.streak = 1
	assert.equal(shouldNudge(state, config), false, 'below threshold')
	state.streak = 2
	assert.equal(shouldNudge(state, config), true)
	markNudged(state)
	assert.equal(shouldNudge(state, config), false, 'cap reached')
})

test('beginTurn resets per-turn counters but keeps the session escalation count', () => {
	const state = initialState()
	state.armed = true
	state.streak = 3
	state.nudgedTotal = 2
	beginTurn(state)
	assert.equal(state.turn, 1)
	assert.equal(state.streak, 0)
	assert.equal(state.armed, false)
	assert.equal(state.nudgesThisTurn, 0)
	assert.equal(state.nudgedTotal, 2)
})

test('nudge wording escalates and is language-aware (but stable per count)', () => {
	const first = nudgeText('zh', 1, 1)
	const second = nudgeText('zh', 2, 2)
	assert.notEqual(first, second)
	assert.equal(first, nudgeText('zh', 1, 1))
	assert.ok(first.includes('过程叙述'))
	assert.ok(nudgeText('en', 1, 1).includes('Narration reminder'))
	assert.notEqual(nudgeText('en', 1, 1), nudgeText('en', 3, 3))
})

test('contract text is constant and never depends on state', () => {
	assert.equal(contractText('zh', 'full'), contractText('zh', 'full'))
	assert.notEqual(contractText('zh', 'full'), contractText('zh', 'short'))
	assert.ok(contractText('zh', 'full').startsWith('## 过程叙述'))
	assert.ok(contractText('zh', 'short').length < contractText('zh', 'full').length)
})

test('stateFor keeps the map bounded', () => {
	const states = createStates()
	for (let i = 0; i < 260; i += 1) stateFor(states, 'session-' + i)
	assert.equal(states.size, 200)
	assert.ok(states.has('session-259'))
	assert.equal(states.has('session-0'), false)
})
