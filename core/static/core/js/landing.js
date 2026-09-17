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
