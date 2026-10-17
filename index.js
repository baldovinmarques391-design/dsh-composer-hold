/**
 * dsh-composer-hold — host half.
 *
 * THE GATE
 * While a session is LOCKED, every waking delivery that is not the human's own
 * message is demoted to the `next-step` bucket with `wakeup:false`: it waits in
 * the inbox and the agent never opens a new turn. The human's next message
 * lifts the lock, and the driver's first `preStep('next-turn')` then claims the
 * whole `next-step` batch plus that one `next-turn` message in ONE request, so
 * the model reads the parked injections and the user's message together.
 *
 * WHY WRAPPING `Agent.send` IS THE WHOLE MECHANISM
 * `followup()`, `steer()` and `inject()` all forward to `send(message, target,
 * wakeup)` (installed `dsh-agent-loop/lib/index.js:800-814`), and every
 * external producer — background jobs, subagent settlement, the schedule
 * service, webhooks, the goal round driver, hooks — reaches an agent through
 * one of those three. One own property on the agent instance therefore catches
 * all of them.
 *
 * MEASURED FACTS THIS BUILD RELIES ON (instance 3080, 2026-10-16)
 *   - `ctx.agents.get(sessionId)` and the object a producer receives are the
 *     SAME `ReactLoopAgent`: the API-session controller's `resolveAgent()`
 *     answers with an envelope `{agent}`, and that `agent` is the registry
 *     entry. So one wrapper covers every producer.
 *   - `ctx.agents.resolveAgent` does NOT exist in this build; the envelope
 *     shape above is the only reliable unwrap.
 *   - `agent/created` DOES reach a plain root plugin row, and fires for every
 *     session the Web client resolves.
 *
 * A failed gate has to be diagnosable, so `GET /state` reports the live agent
 * ids, whether each carries this plugin's own `send`, and every send the
 * wrapper has seen. `source.kind === 'user'` is the only thing treated as the
 * human; everything else is a producer, by construction.
 *
 * @module dsh-composer-hold
 */

const BASE = '/plugin/dsh-composer-hold'

/** Loader row name. */
export const name = 'composer-hold'

/**
 * Process-wide gate state. Deliberately NOT an instance closure: deleting and
 * re-inserting a loader row re-instantiates the plugin (fresh closure) while
 * wrapped agents and in-flight deliveries still hold the old one. Through a
 * `globalThis` symbol every generation reads the same Set, so an old wrapper
 * still consults the current lock state.
 */
function shared() {
	const key = Symbol.for('dsh-composer-hold.state')
	let state = globalThis[key]
	if (state === undefined) {
		state = {
			/** Session ids whose waking deliveries are held. */
			held: new Set(),
			/** Agent objects already wrapped. */
			wrapped: new WeakSet(),
			createdCount: 0,
			appliedCount: 0,
			sendCount: 0,
			heldCount: 0,
			releasedCount: 0,
			passCount: 0,
			lastSends: [],
			lastError: undefined,
			routeInstalled: 0,
			routeFailed: 0,
			log: [],
		}
		globalThis[key] = state
	}
	state.appliedCount += 1
	return state
}

/** The human is identified by the message source, never by role. Negative test on purpose. */
function isHuman(message) {
	return message?.source?.kind === 'user'
}

/** Short, log-safe description of one message. */
function describe(message) {
	const kind = message?.source?.kind ?? 'unknown'
	const text = Array.isArray(message?.content)
		? message.content.filter((block) => block?.type === 'text').map((block) => block.text).join(' ')
		: ''
	return `${kind}|${String(text).slice(0, 48)}`
}

/** Read the `nextStep` bucket without depending on its private shape. */
function nextStepOf(agent) {
	const step = agent?.inbox?.nextStep
	if (Array.isArray(step)) return step
	if (typeof step?.toArray === 'function') return step.toArray()
	if (typeof step?.length === 'number') return Array.from(step)
	return []
}

/** Parked, non-human messages: the number the badge shows. */
function parkedCount(agent) {
	return nextStepOf(agent).filter((message) => !isHuman(message)).length
}

/** Whether the object carries MY own `send`, not the prototype's. */
function ownSend(agent) {
	return agent !== undefined && agent !== null && Object.prototype.hasOwnProperty.call(agent, 'send')
}

/**
 * Describe an object's shape. Kept because getting this wrong is silent: an
 * envelope `{agent}` looks like "the agent" to any code that only checks for
 * truthiness, and then every method on it is `undefined`.
 */
function shapeOf(value) {
	if (value === null || value === undefined) return { type: String(value) }
	if (typeof value !== 'object') return { type: typeof value }
	const marks = {}
	for (const name of ['send', 'followup', 'steer', 'inject', 'cancel', 'status', 'id', 'session', 'inbox', 'ctx', 'agent', 'error']) {
		marks[name] = name in value ? typeof value[name] : 'absent'
	}
	return {
		ctor: value.constructor?.name ?? 'none',
		ownKeys: Object.keys(value).slice(0, 18),
		marks,
	}
}

/** Wrap one agent's `send` exactly once. Returns whether this call installed it. */
function wrapAgent(agent, state, log) {
	if (agent === null || typeof agent !== 'object' || typeof agent.send !== 'function') return false
	if (state.wrapped.has(agent)) return false
	state.wrapped.add(agent)
	const original = agent.send
	agent.send = function send(message, target, wakeup) {
		try {
			state.sendCount += 1
			if (state.held.has(this.id)) {
				if (isHuman(message)) {
					// The human's own message lifts the lock and is delivered as-is, so
					// the driver's next step claims the parked batch together with it.
					state.held.delete(this.id)
					state.releasedCount += 1
					log(`release ${this.id} <- ${describe(message)}`)
				} else if (wakeup) {
					state.heldCount += 1
					state.lastSends.unshift({ at: Date.now(), id: this.id, src: describe(message), target, action: 'held' })
					state.lastSends.length = Math.min(state.lastSends.length, 10)
					log(`hold ${this.id} <- ${describe(message)} (${target} -> next-step, no wake)`)
					return original.call(this, message, 'next-step', false)
				}
			} else {
				state.passCount += 1
			}
		} catch (error) {
			// A wrapper that throws would break delivery itself; degrade to pass-through.
			state.lastError = { where: 'send', message: String(error?.message ?? error) }
		}
		return original.call(this, message, target, wakeup)
	}
	return true
}

/** Answer one HTTP request with JSON. */
function json(res, status, body) {
	const text = JSON.stringify(body)
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
	res.end(text)
}

/** Read a JSON request body (bounded). */
async function readBody(req) {
	const chunks = []
	let size = 0
	for await (const chunk of req) {
		size += chunk.length
		if (size > 64 * 1024) throw new Error('body too large')
		chunks.push(chunk)
	}
	if (chunks.length === 0) return {}
	const text = Buffer.concat(chunks).toString('utf8')
	return text.trim() === '' ? {} : JSON.parse(text)
}

/**
 * Arm the gate.
 *
 * `inject` is deliberately NOT declared: a declared `inject` defers `apply`
 * until those services exist, and this row must see `agent/created` from the
 * start. Waiting for services happens inside an explicit `ctx.inject`
 * callback instead.
 *
 * @param ctx - this row's context.
 */
export function apply(ctx) {
	const state = shared()
	const log = (line) => {
		state.log.unshift({ at: Date.now(), line })
		state.log.length = Math.min(state.log.length, 30)
		ctx.logger?.info?.(`composer-hold: ${line}`)
	}

	try {
		const services = { agents: undefined, webServer: undefined }

		const collect = (sessionId) => {
			const agent = services.agents?.get?.(sessionId)
			if (agent === undefined) return { found: false, wrapped: false, ownSend: false, agentId: undefined }
			const wrapped = wrapAgent(agent, state, log)
			return { found: true, wrapped, ownSend: ownSend(agent), agentId: agent.id }
		}

		const statusOf = (sessionId) => {
			const agent = sessionId === undefined ? undefined : services.agents?.get?.(sessionId)
			const collected = sessionId === undefined
				? { found: false, wrapped: false, ownSend: false, agentId: undefined }
				: collect(sessionId)
			return {
				sessionId: sessionId ?? null,
				locked: sessionId !== undefined && state.held.has(sessionId),
				parked: agent === undefined ? 0 : parkedCount(agent),
				running: agent?.status === 'running',
				diagnostics: {
					found: collected.found,
					wrapped: collected.wrapped,
					ownSend: collected.ownSend,
					agentId: collected.agentId,
					heldSize: state.held.size,
					createdCount: state.createdCount,
					appliedCount: state.appliedCount,
					sendCount: state.sendCount,
					heldCount: state.heldCount,
					releasedCount: state.releasedCount,
					passCount: state.passCount,
					liveAgents: services.agents?.list?.().map((item) => item.id) ?? [],
					routeInstalled: state.routeInstalled,
					routeFailed: state.routeFailed,
					lastError: state.lastError,
					lastSends: state.lastSends,
					log: state.log,
				},
			}
		}

		const handle = async (req, res) => {
			const url = new URL(req.url ?? '/', 'http://127.0.0.1')
			const path = url.pathname.slice(BASE.length) || '/'
			const querySid = url.searchParams.get('sessionId') ?? undefined

			if (req.method === 'GET' && (path === '/' || path === '/state')) {
				return json(res, 200, statusOf(querySid))
			}

			if (req.method === 'POST' && path === '/mode') {
				const body = await readBody(req)
				const target = String(body.sessionId ?? '')
				if (target === '') return json(res, 400, { error: 'sessionId is required' })
				if (body.mode === 'lock') {
					// Order matters: mark held FIRST, so a delivery racing the cancel
					// cannot slip through the window between the two.
					state.held.add(target)
					const collected = collect(target)
					const agent = services.agents?.get?.(target)
					// Locking means "stop this turn, keep the inbox" — that is the old
					// stop button plus a closed door. `keepInbox` preserves anything
					// already parked.
					if (agent?.status === 'running') agent.cancel({ kind: 'user' }, { keepInbox: true })
					log(`lock ${target} (found=${collected.found} ownSend=${collected.ownSend})`)
					return json(res, 200, statusOf(target))
				}
				if (body.mode === 'unlock') {
					state.held.delete(target)
					log(`unlock ${target}`)
					return json(res, 200, statusOf(target))
				}
				return json(res, 400, { error: 'mode must be "lock" or "unlock"' })
			}

			// Diagnostic projection for the self-test bundle: the installed
			// API-session controller answers with an envelope `{agent}` and the
			// registry has no `resolveAgent`, both of which are easy to get wrong
			// when probing the gate. This endpoint reports the real shapes.
			if (req.method === 'GET' && path === '/agents') {
				const sid = querySid
				const fromGet = sid === undefined ? undefined : services.agents?.get?.(sid)
				return json(res, 200, {
					liveAgents: services.agents?.list?.().map((item) => item.id) ?? [],
					agentsApi: {
						hasGet: typeof services.agents?.get === 'function',
						hasResolveAgent: typeof services.agents?.resolveAgent === 'function',
					},
					requested: sid === undefined ? null : {
						get: shapeOf(fromGet),
						wrapped: fromGet !== undefined && state.wrapped.has(fromGet),
						ownSend: ownSend(fromGet),
					},
				})
			}

			return json(res, 404, { error: `no such route: ${path}` })
		}

		ctx.inject(['agents', 'webServer'], (scoped) => {
			services.agents = scoped.get('agents')
			services.webServer = scoped.get('webServer')

			scoped.on('agent/created', (payload) => {
				state.createdCount += 1
				const agent = payload?.agent
				if (agent !== undefined) wrapAgent(agent, state, log)
			})
			for (const agent of services.agents?.list?.() ?? []) wrapAgent(agent, state, log)

			const ws = services.webServer
			if (ws === undefined) {
				state.routeFailed += 1
				log('webServer service is unavailable; the state endpoint is not mounted')
				return
			}
			try {
				const disposer = ws.register({
					kind: 'prefix',
					path: BASE,
					handler: (req, res) => {
						void handle(req, res).catch((error) => {
							state.lastError = { where: 'handler', message: String(error?.message ?? error) }
							try { json(res, 500, state.lastError) } catch { /* already sent */ }
						})
					},
				})
				state.routeInstalled += 1
				log(`route mounted at ${BASE}`)
				scoped.effect(() => () => {
					try { disposer?.() } catch { /* already gone */ }
				}, 'composer-hold: state endpoint')
			} catch (error) {
				// A duplicate (kind,path) registration throws. It must never escape
				// this callback: an unhandled rejection would take the host down.
				state.routeFailed += 1
				log(`route already registered, reusing it: ${String(error?.message ?? error)}`)
			}
		})
	} catch (error) {
		state.lastError = { where: 'apply', message: String(error?.message ?? error) }
		ctx.logger?.warn?.(`composer-hold: apply failed: ${String(error?.message ?? error)}`)
	}
}
