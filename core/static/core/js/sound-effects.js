(() => {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const toggle = document.querySelector('[data-sound-toggle]');
    if (!AudioContext || !toggle) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const buffers = new Map();
    let context;
    let active;
    let requestId = 0;
    let muted = false;
    try { muted = localStorage.getItem('mindmate-effects-muted') === 'true'; } catch { /* Storage is optional. */ }

    function updateToggle() {
        toggle.hidden = false;
        toggle.setAttribute('aria-pressed', String(!muted));
        const label = muted ? '开启界面音效' : '关闭界面音效';
        toggle.setAttribute('aria-label', label);
        toggle.title = label;
        toggle.querySelector('.effects-on').hidden = muted;
        toggle.querySelector('.effects-off').hidden = !muted;
    }

    // Original, low-pass interface sounds with no alert-like tones or hard attacks.
    function makeBuffer(kind) {
        const rate = context.sampleRate;
        const duration = kind === 'transition' ? .28 : 3.45;
        const buffer = context.createBuffer(2, Math.ceil(rate * duration), rate);
        const left = buffer.getChannelData(0);
        const right = buffer.getChannelData(1);
        let seed = 917;
        const random = () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed / 2147483648 - 1;
        };
        function mix(index, sample, pan) {
            const angle = (pan + 1) * Math.PI / 4;
            left[index] += sample * Math.cos(angle);
            right[index] += sample * Math.sin(angle);
        }
        function softNoise({ start, length, volume, fromFrequency, toFrequency, fromPan, toPan, fadeIn, fadeOut }) {
            // Cascaded one-pole filters create a warm slope with no energy above 2 kHz.
            let lowOne = 0;
            let lowTwo = 0;
            let lowThree = 0;
            const offset = Math.floor(start * rate);
            const frames = Math.min(Math.floor(length * rate), left.length - offset);
            for (let index = 0; index < frames; index++) {
                const elapsed = index / rate;
                const progress = frames > 1 ? index / (frames - 1) : 1;
                const frequency = Math.min(1900, fromFrequency + (toFrequency - fromFrequency) * progress);
                const coefficient = 1 - Math.exp(-2 * Math.PI * frequency / rate);
                lowOne += coefficient * (random() - lowOne);
                lowTwo += coefficient * (lowOne - lowTwo);
                lowThree += coefficient * (lowTwo - lowThree);
                const attack = Math.min(1, elapsed / fadeIn);
                const release = Math.min(1, (length - elapsed) / fadeOut);
                const envelope = Math.sin(Math.min(1, attack) * Math.PI / 2)
                    * Math.sin(Math.min(1, release) * Math.PI / 2);
                mix(offset + index, lowThree * envelope * volume,
                    fromPan + (toPan - fromPan) * progress);
            }
        }
        if (kind === 'transition') {
            softNoise({
                start: 0, length: .28, volume: .15,
                fromFrequency: 1150, toFrequency: 520,
                fromPan: -.12, toPan: .12,
                fadeIn: .05, fadeOut: .15,
            });
        } else {
            // Three nearly subliminal fabric-soft folds, aligned with the paper shape change.
            softNoise({ start: .18, length: .10, volume: .055, fromFrequency: 700, toFrequency: 480, fromPan: -.04, toPan: .02, fadeIn: .025, fadeOut: .06 });
            softNoise({ start: .56, length: .11, volume: .06, fromFrequency: 760, toFrequency: 500, fromPan: .03, toPan: -.02, fadeIn: .025, fadeOut: .065 });
            softNoise({ start: .96, length: .09, volume: .045, fromFrequency: 650, toFrequency: 430, fromPan: -.02, toPan: .03, fadeIn: .02, fadeOut: .055 });
            // The plane appears at 1.25s; warm air moves slightly right and fades into distance.
            softNoise({
                start: 1.25, length: 2.12, volume: .105,
                fromFrequency: 780, toFrequency: 180,
                fromPan: -.14, toPan: .28,
                fadeIn: .12, fadeOut: .72,
            });
        }
        return buffer;
    }

    function stop() {
        requestId++;
        if (!active) return;
        const { source, gain } = active;
        active = null;
        const now = context.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, now + .025);
        source.stop(now + .03);
    }

    async function play(kind) {
        stop();
        if (muted || reducedMotion.matches || document.hidden) return;
        const id = requestId;
        const startedAt = performance.now();
        try {
            context ||= new AudioContext();
            if (context.state !== 'running') await context.resume();
            if (id !== requestId || context.state !== 'running') return;
            if (!buffers.has(kind)) buffers.set(kind, makeBuffer(kind));
            const buffer = buffers.get(kind);
            // Browser audio activation may be delayed; keep sound aligned with the visual.
            const offset = (performance.now() - startedAt) / 1000;
            if (offset >= buffer.duration) return;
            const source = context.createBufferSource();
            const gain = context.createGain();
            source.buffer = buffer;
            source.connect(gain).connect(context.destination);
            gain.gain.setValueAtTime(0, context.currentTime);
            gain.gain.linearRampToValueAtTime(.72, context.currentTime + .018);
            active = { source, gain };
            source.onended = () => {
                source.disconnect();
                gain.disconnect();
                if (active?.source === source) active = null;
            };
            source.start(0, offset);
        } catch {
            // Sound is optional: blocked audio must never interrupt navigation or writing.
            stop();
        }
    }

    toggle.addEventListener('click', () => {
        muted = !muted;
        if (muted) stop();
        try { localStorage.setItem('mindmate-effects-muted', String(muted)); } catch { /* no-op */ }
        updateToggle();
    });
    window.addEventListener('storage', (event) => {
        if (event.key !== 'mindmate-effects-muted' && event.key !== null) return;
        muted = event.newValue === 'true';
        if (muted) stop();
        updateToggle();
    });
    window.addEventListener('pagehide', stop);
    window.addEventListener('pageshow', (event) => {
        if (!event.persisted) return;
        try { muted = localStorage.getItem('mindmate-effects-muted') === 'true'; } catch { /* no-op */ }
        updateToggle();
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
    reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) stop(); });
    window.MindmateSounds = {
        transition: () => play('transition'),
        paperFlight: () => play('paper-flight'),
        stop,
    };
    updateToggle();
})();
