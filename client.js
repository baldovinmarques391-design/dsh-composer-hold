/**
 * dsh-composer-hold — browser half.
 *
 * WHAT IT RENDERS
 * One key in the composer's right-hand control row, with five faces:
 *
 *   grey  ↑   idle, no draft, nothing running       (inert)
 *   blue  ↑   a draft is ready to send              (send)
 *   blue  ‖   the main turn is running              (soft stop: cancels that turn only)
 *   blue  ▶   you pressed ‖, the door is still open (press again to lock)
 *   grey  ■   locked: wake-ups are being held       (inert — type and press Enter)
 *
 * `‖ → ▶` is the soft stop: it cancels the current turn exactly like the
 * product's stop button, but a background job or a subagent can still wake the
 * agent. `▶ → ■` closes the door; the host half then parks every non-human
 * wake-up until the user's own next message releases them in ONE request.
 *
 * WHY IT TAKES OVER THE PRODUCT'S BUTTON
 * The send/stop button is not a slot — it is a `<button>` inside InputBar — and
 * a third-party client plugin cannot reach the Lexical editor or the private
 * `keyboard` face needed to rebuild the composer. So this plugin renders its own
 * key and hides that one, then DELEGATES every send to it: the product still
 * owns submission, queueing, steering, attachments and slash commands. The Enter
 * path is never touched, which is also the safety net — if this key ever breaks,
 * Enter still sends.
 *
 * The product's button is identified by its icon geometry (the up-arrow `path`
 * or the 10×10 stop `rect`), never by a class name, and the takeover is skipped
 * entirely inside a subagent session, which has its own stop button on a
 * different channel.
 */
window.__ModuleLoader__.load({
  id: 'dsh-composer-hold',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const BASE = '/plugin/dsh-composer-hold'
    const PLUGIN_ID = 'dsh-composer-hold'
    /**
     * Bumped on every behavioural change to this half. It is stamped onto the
     * rendered element so "is the browser running the current build?" is a read,
     * not a guess — several rounds were spent diagnosing stale bundles.
     */
    const HOLD_VERSION = 'client-2026-10-17b'

    const zh = {
      send: '发送',
      stop: '停止（只停当前回合）',
      hold: '绝对停止：扣住一切外部注入',
      held: '已锁定：外部注入被扣住，发消息才放行',
      settled: '空闲',
      idle: '没有可发送的内容',
      badge: '扣住 {n} 条外部注入',
      badgeRun: '扣住 {n} 条外部注入 · 还有 {k} 项在跑',
    }
    const en = {
      send: 'Send',
      stop: 'Stop this turn',
      hold: 'Absolute stop: hold every external injection',
      held: 'Locked: injections are held until you send',
      settled: 'Idle',
      idle: 'Nothing to send',
      badge: '{n} external injection(s) held',
      badgeRun: '{n} external injection(s) held · {k} still running',
    }

    const CSS = [
      '.dsh-hold-root{position:relative;flex:none;display:flex;align-items:center}',
      '.dsh-hold-key{box-sizing:border-box;width:34px;height:34px;border-radius:50%;border:0;padding:0;',
      'display:grid;place-items:center;cursor:pointer;color:#fff;',
      'background:var(--dsw-alias-button-info-fill);transform:translateY(-2px);transition:opacity .12s ease}',
      '.dsh-hold-key[data-inert="1"]{cursor:default;opacity:.4}',
      '.dsh-hold-key[data-hard="1"]{opacity:.4;cursor:default}',
      '.dsh-hold-key:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.dsh-hold-badge{position:absolute;top:-2px;right:-2px;min-width:15px;height:15px;padding:0 3px;border-radius:8px;',
      'background:var(--dsw-alias-state-warning-primary,#e08b00);color:#fff;font-size:10px;line-height:15px;',
      'text-align:center;font-weight:600;pointer-events:none;box-shadow:0 0 0 1.5px var(--dsw-specific-input-major,transparent)}',
    ].join('')

    /** One inline SVG glyph in the product's 16×16 viewBox. */
    function Glyph(props) {
      const common = { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true }
      if (props.glyph === 'up') {
        return h('svg', common, h('path', {
          d: 'M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z',
          fill: 'currentColor',
        }))
      }
      if (props.glyph === 'pause') {
        return h('svg', common,
          h('rect', { x: 4, y: 3, width: 3, height: 10, rx: 1, fill: 'currentColor' }),
          h('rect', { x: 9, y: 3, width: 3, height: 10, rx: 1, fill: 'currentColor' }))
      }
      if (props.glyph === 'play') {
        return h('svg', common, h('path', { d: 'M4.5 2.6 13 8l-8.5 5.4Z', fill: 'currentColor' }))
      }
      return h('svg', common, h('rect', { x: 3, y: 3, width: 10, height: 10, rx: 3, fill: 'currentColor' }))
    }

    const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

    /**
     * Whether an element is the product's send/stop key. Two geometric facts,
     * either decisive on its own: the up-arrow path, or the stop square. A class
     * name would be a stronger contract but it is minified.
     */
    function isProductPrimary(element) {
      if (element === null || element === undefined || element.tagName !== 'BUTTON') return false
      const svg = element.querySelector('svg')
      if (svg === null) return false
      const path = svg.querySelector('path')
      const rect = svg.querySelector('rect')
      const isArrow = (path?.getAttribute('d') ?? '').startsWith('M8.3125 0.980183')
      const isSquare = rect?.getAttribute('x') === '3' && rect.getAttribute('y') === '3' && rect.getAttribute('width') === '10'
      return isArrow || isSquare
    }

    /**
     * The product's primary key inside the composer card that owns this node.
     *
     * It is deliberately allowed to be the button {@link takeover} already marked
     * `dshHoldReplaced` and hid: that IS the button this key delegates to. An
     * earlier version skipped replaced buttons here, so after takeover had run the
     * delegate found nothing and a mouse press on the key did nothing at all
     * (Enter still worked, because it never goes through this key).
     */
    function productPrimaryNear(node) {
      const scope = node?.closest?.('[data-composer-card]') ?? document
      for (const button of scope.querySelectorAll('button')) {
        // NEVER our own key: it draws the same up-arrow glyph as the product's
        // send button, so an icon-only test matched our own button and hid it.
        if (button.closest('[data-dsh-hold-key]') !== null) continue
        if (isProductPrimary(button)) return button
      }
      return null
    }

    /**
     * Press the product's key on the user's behalf.
     *
     * A hidden button still dispatches a synthetic click, but a DISABLED one does
     * not, and the product disables its key whenever it considers the draft empty
     * or the machine busy. The click is therefore issued with `disabled` cleared
     * for that one dispatch and restored immediately after, so the product's own
     * eligibility rules still decide what happens — we only guarantee that our
     * key's press actually reaches it.
     *
     * @param node - this key's root node.
     * @returns whether a key was found and clicked.
     */
    function pressProductKey(node) {
      const primary = productPrimaryNear(node)
      if (primary === null) return false
      try {
        const wasDisabled = primary.disabled === true
        if (wasDisabled) primary.disabled = false
        primary.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
        primary.click()
        if (wasDisabled) setTimeout(() => { try { primary.disabled = true } catch { /* gone */ } }, 0)
        return true
      } catch {
        return false
      }
    }

    /** Hide one element without ever throwing; returns whether it is hidden now. */
    function hideElement(element) {
      try {
        element.style.display = 'none'
        element.setAttribute('aria-hidden', 'true')
        element.dataset.dshHoldReplaced = '1'
        return true
      } catch {
        return false
      }
    }

    /**
     * Keep the product's key out of the layout for as long as this component is
     * mounted. Hiding it ONCE was not enough: the product re-mounts that button
     * when the turn starts and stops, and a single layout effect that ran before
     * the button existed left both keys on screen. The observer re-hides it
     * whenever the card's children change, which is the only reliable way to win
     * a race against React's own re-renders.
     *
     * @param node - this key's root node, inside the composer card.
     * @returns cleanup that restores ordering and stops observing.
     */
    function takeover(node) {
      const card = node?.closest?.('[data-composer-card]') ?? null
      const scope = card ?? document

      const hideAll = () => {
        for (const button of scope.querySelectorAll('button')) {
          if (button.closest('[data-dsh-hold-key]') !== null) continue
          if (isProductPrimary(button)) hideElement(button)
        }
      }
      hideAll()

      // Sit at the end of the trailing flex row.
      const row = node.parentElement
      const previousOrder = row === null ? undefined : row.style.order
      if (row !== null) row.style.order = '9'

      let observer
      if (typeof MutationObserver === 'function') {
        observer = new MutationObserver(() => { hideAll() })
        try {
          observer.observe(scope === document ? document.body : scope, { childList: true, subtree: true })
        } catch { observer = undefined }
      }
      // A second pass on the next frame covers a product key that React commits
      // after this effect but in the same tick.
      const frame = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(() => { hideAll() })
        : undefined

      return () => {
        if (observer !== undefined) observer.disconnect()
        if (frame !== undefined && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
        if (row !== null) row.style.order = previousOrder ?? ''
      }
    }

    /** Shared, apply-scoped plumbing for every controller and mount. */
    const env = { sessions: undefined, jobs: undefined }

    /** One control state per Session id, shared by every mount in this tab. */
    function makeController(sessionId) {
      const listeners = new Set()
      let value = { locked: false, parked: 0, soft: false, ready: false, busy: false, running: false, liveJobs: 0, failure: undefined }
      let poll = 0
      // Cleared on every fresh soft stop; set again by the next turn start.
      let restarted = false

      const emit = (next) => {
        value = next
        for (const listener of listeners) listener()
      }
      const patch = (part) => emit({ ...value, ...part })

      const syncPoll = () => {
        // Poll only while the door is shut: that is the one fact this tab cannot
        // learn from its own actions (another tab may have opened it).
        if (value.locked && poll === 0) poll = setInterval(() => { void refresh() }, 4000)
        if (!value.locked && poll !== 0) { clearInterval(poll); poll = 0 }
      }

      const refresh = async () => {
        try {
          const response = await fetch(`${BASE}/state?sessionId=${encodeURIComponent(sessionId)}`, { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`state ${response.status}`)
          const body = await response.json()
          patch({ locked: body.locked === true, parked: Number(body.parked) || 0, ready: true, failure: undefined })
        } catch (error) {
          patch({ failure: String(error?.message ?? error) })
        }
        syncPoll()
      }

      const postMode = async (mode) => {
        const response = await fetch(`${BASE}/mode`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, mode }),
        })
        if (!response.ok) throw new Error(`mode ${response.status}`)
        return response.json()
      }

      // Declared after `refresh` on purpose: the closures above only run later.
      const controller = {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        refresh,
        /** Two delayed re-reads: the host's answer may land after a cancel. */
        refreshSoon() {
          setTimeout(() => { void refresh() }, 600)
          setTimeout(() => { void refresh() }, 2000)
        },
        setRunning(running) {
          if (value.running === running) return
          if (running) restarted = true
          patch({ running })
        },
        setLiveJobs(count) { if (value.liveJobs !== count) patch({ liveJobs: count }) },
        clearSoft() { if (value.soft) patch({ soft: false }) },
        /** Whether a turn has begun since the last soft stop: the mode's real exit. */
        turnRestarted() { return restarted },
        /** Diagnostics for the DOM: what this key believes right now. */
        debugInfo() { return { liveJobs: value.liveJobs, soft: value.soft, locked: value.locked, parked: value.parked } },
        /** Soft stop: cancel this turn, leave the door open. */
        async stop() {
          if (value.soft) return
          restarted = false
          patch({ soft: true })
          try {
            const binding = env.sessions?.binding?.(sessionId)
            const session = binding?.session ?? binding
            if (typeof session?.cancel === 'function') await session.cancel()
          } catch (error) {
            patch({ failure: String(error?.message ?? error) })
          }
        },
        /** Close the door. */
        async lock() {
          if (value.busy) return
          patch({ busy: true })
          try {
            const body = await postMode('lock')
            patch({ locked: body.locked === true, parked: Number(body.parked) || 0, soft: false, busy: false, failure: undefined })
          } catch (error) {
            patch({ busy: false, failure: String(error?.message ?? error) })
          }
          syncPoll()
        },
        async unlock() {
          try { await postMode('unlock') } catch { /* the state read reports the truth */ }
          // A submission is also the natural end of the soft-stop mode. Written
          // as a direct patch rather than `controller.clearSoft()`: referring to
          // the enclosing `const` from inside its own initializer is a temporal
          // dead zone, and the previous form threw the moment anything called it.
          patch({ locked: false, soft: false })
          void refresh()
        },
        dispose() { if (poll !== 0) clearInterval(poll); poll = 0; listeners.clear() },
      }
      return controller
    }

    const controllers = new Map()
    function controllerFor(sessionId) {
      let controller = controllers.get(sessionId)
      if (controller === undefined) {
        controller = makeController(sessionId)
        controllers.set(sessionId, controller)
        void controller.refresh()
      }
      return controller
    }

    /**
     * The key itself, wrapped so that a throw inside it can never make the whole
     * control vanish. A disappearing key is indistinguishable from "the plugin is
     * not installed", so a failure renders a visible, inert key that names itself
     * in `data-hold-error` instead.
     */
    function HoldKey(props) {
      try {
        return HoldKeyBody(props)
      } catch (error) {
        const message = String(error?.message ?? error)
        return h('div', { className: 'dsh-hold-root', 'data-dsh-hold-key': '1', 'data-hold-error': message },
          h('button', { type: 'button', className: 'dsh-hold-key', 'data-face': 'idle', 'data-inert': '1', title: `composer-hold: ${message}` },
            h(Glyph, { glyph: 'up' })))
      }
    }

    /** The real key. */
    function HoldKeyBody(props) {
      const { sessionId, useSession, useInput } = props
      const controller = controllerFor(sessionId)
      // Every hook runs before any early return: the subagent case below must not
      // change hook order between renders.
      const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
      const draft = useInput((input) => input?.draft ?? '')
      const attachments = useInput((input) => input?.attachmentIds?.length ?? 0)
      const pending = useSession((session) => session?.pendingSubmissions?.length ?? 0)
      const subagent = useSession((session) => session?.subagent ?? null)
      const running = useSession((session) => session?.running === true)
      const nodeRef = React.useRef(null)

      React.useEffect(() => { controller.setRunning(running) }, [running, controller])
      // `soft` is a MODE, and it must survive the stop itself. Cancelling a turn
      // makes `running` fall from true to false, and that is NOT a restart — an
      // earlier version cleared the mode right there, which teleported the key
      // from ‖ to grey ↑ without ever showing ▶. Only two things end the mode:
      //   - the turn starts again AFTER the stop (your message went out, or a
      //     wake-up got through because the door was still open);
      //   - the door is shut, so the absolute stop owns the display.
      React.useEffect(() => {
        if (!state.soft) return
        if (state.locked || controller.turnRestarted()) controller.clearSoft()
      }, [state.soft, state.locked, running, controller])
      // A local submission is the moment the door opens. The host half releases
      // the lock itself when the human message reaches `Agent.send` — but the
      // product's own send path goes through `api/session/prompt`, which does NOT
      // necessarily pass that wrapper. So this side owns the release too: if a
      // submission appears while the door is shut, open it explicitly.
      React.useEffect(() => {
        if (pending <= 0) return
        if (state.locked) void controller.unlock()
        else controller.refreshSoon()
      }, [pending, state.locked, controller])

      React.useEffect(() => {
        const jobs = env.jobs
        if (jobs === undefined) return undefined
        const read = () => {
          const rows = jobs.state?.getSnapshot?.()?.rows?.[sessionId] ?? []
          controller.setLiveJobs(rows.filter((job) => job.status === 'running' || job.status === 'stopping').length)
        }
        read()
        const stopWatch = jobs.watchRows?.(sessionId)
        const unsubscribe = jobs.state?.subscribe?.(read)
        return () => { unsubscribe?.(); stopWatch?.() }
      }, [sessionId, controller])

      // Layout effect: the product's key must not paint even one frame.
      React.useLayoutEffect(() => {
        const node = nodeRef.current
        if (node === null) return undefined
        return takeover(node)
      }, [sessionId])

      // A subagent session has its own stop channel; leave it entirely alone.
      // `undefined` means "the session snapshot is not resolved yet", NOT "this is
      // a subagent session" — testing `!== null` made the component render
      // nothing until that snapshot arrived, which looked exactly like a lost key.
      if (subagent !== null && subagent !== undefined) return null

      const locked = state.locked === true
      const hasDraft = draft.trim().length > 0 || attachments > 0
      const settled = state.liveJobs === 0
      let face
      if (locked && hasDraft) face = 'send'
      else if (locked && settled) face = 'settled'
      else if (locked) face = 'held'
      else if (state.soft) face = 'soft'
      else if (running) face = 'running'
      else if (hasDraft) face = 'send'
      else face = 'idle'

      const inert = face === 'idle' || face === 'settled' || face === 'held'
      const label = state.failure !== undefined
        ? `composer-hold: ${state.failure}`
        : face === 'send' ? props.t('send')
          : face === 'running' ? props.t('stop')
            : face === 'soft' ? props.t('hold')
              : face === 'held' ? props.t('held')
                : face === 'settled' ? props.t('settled')
                  : props.t('idle')
      const title = state.parked > 0
        ? (settled ? props.t('badge', { n: state.parked }) : props.t('badgeRun', { n: state.parked, k: state.liveJobs }))
        : label

      const onClick = () => {
        if (inert) return
        if (face === 'send') {
          // Delegate to the product's own key: submission, queueing, steering,
          // attachments and slash commands all stay the product's business.
          // `pressProductKey` also covers the hidden/disabled state of that key.
          pressProductKey(nodeRef.current)
          controller.refreshSoon()
          return
        }
        if (face === 'running') { void controller.stop(); return }
        if (face === 'soft') void controller.lock()
      }

      const info = controller.debugInfo()
      return h('div', {
        className: 'dsh-hold-root',
        'data-dsh-hold-key': '1',
        // Which build is actually running: the first question for any "the key
        // went back to the product one" report.
        'data-hold-version': HOLD_VERSION,
        // Readable diagnostics: the two facts a report about a wrong face needs.
        'data-hold-live-jobs': String(info.liveJobs),
        'data-hold-jobs-service': env.jobs === undefined ? 'absent' : 'present',
        'data-hold-soft': info.soft ? '1' : '0',
        'data-hold-running': running ? '1' : '0',
      },
        h('button', {
          ref: nodeRef,
          type: 'button',
          className: 'dsh-hold-key',
          'data-face': face,
          'data-hold-version': HOLD_VERSION,
          'data-hard': face === 'held' ? '1' : undefined,
          'data-inert': inert ? '1' : undefined,
          'aria-label': label,
          title,
          disabled: face === 'idle' || face === 'settled',
          onClick,
        }, h(Glyph, { glyph: face === 'running' ? 'pause' : face === 'soft' ? 'play' : face === 'held' ? 'square' : 'up' })),
        state.parked > 0
          ? h('span', { className: 'dsh-hold-badge', 'data-dsh-hold-badge': '1' }, String(state.parked))
          : null)
    }

    return {
      inject: ['slots', 'locale', 'sessions'],
      apply(ctx) {
        env.sessions = ctx.sessions
        env.jobs = ctx.get('jobs')
        ctx.effect(() => ctx.locale.register('composerHold', { zh, en }), 'composer-hold: dictionaries')
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = PLUGIN_ID
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => { tag.remove() }
        }, 'composer-hold: key styles')
        ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'composer-hold',
          order: 9,
          locale: 'composerHold',
        }, HoldKey)), 'composer-hold: composer key')
        // `jobs` is an OPTIONAL service and is absent in this composition (the
        // real client service catalog has no `jobs`), so it is read lazily here
        // and again by the component's effect; a `ctx.inject(['jobs'])` would
        // simply never fire and must not be the only path to it.
        ctx.inject(['jobs'], (scoped) => {
          env.jobs = scoped.get('jobs') ?? scoped.jobs
        })
      },
    }
  },
})
