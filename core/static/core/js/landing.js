(() => {
    const hero = document.querySelector('.hero');
    const scene = hero?.querySelector('.hero-scene');
    const image = hero?.querySelector('.hero-image');
    const rain = hero?.querySelector('.window-rain');
    const toggle = hero?.querySelector('.scene-toggle');
    if (!scene || !image || !rain || !toggle) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
    const mobile = window.matchMedia('(max-width: 820px)');
    let paused = false;
    let visible = true;
    let pointerFrame = 0;
    let pointerX = 0;
    let pointerY = 0;
    try { paused = localStorage.getItem('mindmate-scene-paused') === 'true'; } catch { /* Storage is optional. */ }

    for (let index = 0; index < 18; index++) {
        const drop = document.createElement('span');
        drop.className = 'rain-drop';
        drop.style.setProperty('--rain-x', ((index * 37) % 100) + '%');
        drop.style.setProperty('--rain-length', (14 + index % 4 * 6) + 'px');
        drop.style.setProperty('--rain-duration', (3.2 + index % 5 * .45) + 's');
        drop.style.setProperty('--rain-delay', (-index * .71) + 's');
        rain.append(drop);
    }

    function resetPointer() {
        window.cancelAnimationFrame(pointerFrame);
        pointerFrame = 0;
        scene.style.removeProperty('--scene-x');
        scene.style.removeProperty('--scene-y');
    }

    function updateMotion() {
        const still = paused || reducedMotion.matches || document.hidden || !visible;
        // Stopping the entrance fade should leave a fully visible, static image.
        if (paused || reducedMotion.matches) hero.classList.add('scene-ready');
        hero.classList.toggle('scene-still', still);
        toggle.hidden = reducedMotion.matches;
        toggle.setAttribute('aria-pressed', String(!paused));
        const label = paused ? '开启背景动态' : '关闭背景动态';
        toggle.setAttribute('aria-label', label);
        toggle.title = label;
        toggle.querySelector('.scene-stop').hidden = paused;
        toggle.querySelector('.scene-play').hidden = !paused;
        if (still || !finePointer.matches) resetPointer();
    }

    // Match cover scaling and background-position so rain stays inside the illustrated window.
    function fitWindow() {
        const width = image.clientWidth;
        const height = image.clientHeight;
        const scale = Math.max(width / 1450, height / 962);
        const offsetX = (width - 1450 * scale) * (mobile.matches ? .63 : .5);
        const offsetY = (height - 962 * scale) * .5;
        rain.style.setProperty('--window-x', (offsetX + 440 * scale) + 'px');
        rain.style.setProperty('--window-y', offsetY + 'px');
        rain.style.setProperty('--window-width', 530 * scale + 'px');
        rain.style.setProperty('--window-height', 510 * scale + 'px');
        rain.style.setProperty('--rain-travel', (510 * scale + 50) + 'px');
    }

    hero.addEventListener('pointermove', (event) => {
        if (hero.classList.contains('scene-still') || !finePointer.matches || event.pointerType === 'touch') return;
        const bounds = hero.getBoundingClientRect();
        pointerX = ((event.clientX - bounds.left) / bounds.width - .5) * -16;
        pointerY = ((event.clientY - bounds.top) / bounds.height - .5) * -10;
        if (pointerFrame) return;
        pointerFrame = window.requestAnimationFrame(() => {
            scene.style.setProperty('--scene-x', pointerX.toFixed(2) + 'px');
            scene.style.setProperty('--scene-y', pointerY.toFixed(2) + 'px');
            pointerFrame = 0;
        });
    });
    hero.addEventListener('pointerleave', resetPointer);
    toggle.addEventListener('click', () => {
        paused = !paused;
        try { localStorage.setItem('mindmate-scene-paused', String(paused)); } catch { /* no-op */ }
        updateMotion();
    });
    image.addEventListener('animationend', (event) => {
        if (event.animationName === 'room-arrive') hero.classList.add('scene-ready');
    });
    document.addEventListener('visibilitychange', updateMotion);
    reducedMotion.addEventListener('change', () => {
        hero.classList.add('scene-ready');
        updateMotion();
    });
    finePointer.addEventListener('change', updateMotion);
    mobile.addEventListener('change', fitWindow);
    window.addEventListener('pageshow', updateMotion);
    window.addEventListener('pagehide', resetPointer);
    if ('IntersectionObserver' in window) {
        new IntersectionObserver(([entry]) => {
            visible = entry.isIntersecting;
            updateMotion();
        }).observe(hero);
    }
    if ('ResizeObserver' in window) new ResizeObserver(fitWindow).observe(image);
    else window.addEventListener('resize', fitWindow);
    fitWindow();
    updateMotion();
})();

(() => {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const hero = document.querySelector('.hero');
    if (!AudioContext || !hero) return;

    const scale = [523.25, 659.25, 783.99, 880, 1046.5, 1174.66];
    const phrases = [
        [0, 2, 4],
        [1, 3, 5],
        [2, 0, 3],
        [4, 2, 1],
    ];
    const activeVoices = new Set();
    let context;
    let master;
    let filter;
    let stereo;
    let sway;
    let swayDepth;
    let phraseTimer;
    let phraseIndex = 0;
    let running = false;
    hero.dataset.ambientState = 'waiting';

    function isMuted() {
        return window.MindmateSounds?.isMuted?.() ?? true;
    }

    function buildAudioGraph() {
        if (master) return;
        master = context.createGain();
        filter = context.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 2400;
        filter.Q.value = .35;
        master.gain.value = .0001;
        if (context.createStereoPanner) {
            stereo = context.createStereoPanner();
            sway = context.createOscillator();
            swayDepth = context.createGain();
            sway.type = 'sine';
            sway.frequency.value = .045;
            swayDepth.gain.value = .26;
            sway.connect(swayDepth).connect(stereo.pan);
            filter.connect(stereo).connect(master).connect(context.destination);
            sway.start();
        } else {
            filter.connect(master).connect(context.destination);
        }
    }

    function makeChime(frequency, when, strength, pan) {
        const voice = context.createGain();
        const partial = context.createGain();
        const tone = context.createOscillator();
        const shimmer = context.createOscillator();
        const panner = context.createStereoPanner?.();
        const destination = panner || filter;
        const duration = 4.4;

        tone.type = 'sine';
        shimmer.type = 'sine';
        tone.frequency.setValueAtTime(frequency, when);
        shimmer.frequency.setValueAtTime(frequency * 2.006, when);
        voice.gain.setValueAtTime(.0001, when);
        voice.gain.exponentialRampToValueAtTime(.048 * strength, when + .11);
        voice.gain.exponentialRampToValueAtTime(.0001, when + duration);
        partial.gain.setValueAtTime(.0001, when);
        partial.gain.exponentialRampToValueAtTime(.009 * strength, when + .16);
        partial.gain.exponentialRampToValueAtTime(.0001, when + 2.8);
        if (panner) panner.pan.value = pan;
        tone.connect(voice).connect(destination);
        shimmer.connect(partial).connect(destination);
        if (panner) panner.connect(filter);

        const record = { tone, shimmer, voice, partial, panner };
        activeVoices.add(record);
        let ended = 0;
        const cleanup = () => {
            ended += 1;
            if (ended < 2) return;
            activeVoices.delete(record);
            tone.disconnect();
            shimmer.disconnect();
            voice.disconnect();
            partial.disconnect();
            panner?.disconnect();
        };
        tone.onended = cleanup;
        shimmer.onended = cleanup;
        tone.start(when);
        shimmer.start(when);
        tone.stop(when + duration + .05);
        shimmer.stop(when + duration + .05);
    }

    function schedulePhrase() {
        if (!running || document.hidden || isMuted()) return;
        const notes = phrases[phraseIndex % phrases.length];
        const now = context.currentTime + .08;
        notes.forEach((note, index) => {
            const drift = index === 0 ? 0 : (index * 1.18 + (phraseIndex % 2) * .22);
            const strength = 1 - index * .12;
            const pan = Math.max(-.7, Math.min(.7, ((phraseIndex + index * 2) % 5 - 2) * .27));
            makeChime(scale[note], now + drift, strength, pan);
        });
        phraseIndex += 1;
        const pause = 7600 + (phraseIndex % 3) * 1300;
        phraseTimer = window.setTimeout(schedulePhrase, pause);
    }

    async function start() {
        if (running || document.hidden || isMuted()) return;
        try {
            context ||= new AudioContext();
            if (context.state !== 'running') await context.resume();
            if (context.state !== 'running' || document.hidden || isMuted()) return;
            buildAudioGraph();
            running = true;
            hero.dataset.ambientState = 'playing';
            const now = context.currentTime;
            master.gain.cancelScheduledValues(now);
            master.gain.setValueAtTime(Math.max(.0001, master.gain.value), now);
            master.gain.exponentialRampToValueAtTime(.32, now + 1.6);
            schedulePhrase();
        } catch {
            stop(true);
        }
    }

    function stop(immediate = false) {
        window.clearTimeout(phraseTimer);
        phraseTimer = null;
        running = false;
        hero.dataset.ambientState = 'stopped';
        if (!context || !master) return;
        const now = context.currentTime;
        master.gain.cancelScheduledValues(now);
        master.gain.setValueAtTime(Math.max(.0001, master.gain.value), now);
        master.gain.exponentialRampToValueAtTime(.0001, now + (immediate ? .03 : .7));
        activeVoices.forEach(({ tone, shimmer }) => {
            try {
                tone.stop(now + (immediate ? .04 : .75));
                shimmer.stop(now + (immediate ? .04 : .75));
            } catch {
                // A voice may have already ended while the page is leaving.
            }
        });
    }

    function unlock() {
        start();
    }

    document.addEventListener('pointerdown', unlock, { once: true, capture: true });
    document.addEventListener('keydown', unlock, { once: true, capture: true });
    window.addEventListener('mindmate-soundchange', (event) => {
        if (event.detail?.muted) stop();
        else start();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stop(true);
        else start();
    });
    window.addEventListener('pageshow', start);
    window.addEventListener('pagehide', () => stop(true));
    window.MindmateAmbient = {
        start,
        stop,
        isPlaying: () => running,
    };
})();
