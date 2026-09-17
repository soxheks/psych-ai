(() => {
    const overlay = document.getElementById('pageTransition');
    if (!overlay) return;

    const label = document.getElementById('transitionLabel');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
    const motionSelector = [
        '.site-header a', '.button', '.path-item', '.chat-site-nav a',
        '.journal-header a', '.paper-footer button',
        '.complete-actions a', '.complete-actions button'
    ].join(', ');
    let leaving = false;

    try {
        const arrivalLabel = sessionStorage.getItem('mindmate-transition');
        if (arrivalLabel && !reducedMotion.matches) {
            label.textContent = arrivalLabel;
            overlay.classList.add('is-arriving');
            sessionStorage.removeItem('mindmate-transition');
            window.setTimeout(() => overlay.classList.remove('is-arriving'), 760);
        }
    } catch {
        // Storage may be disabled; navigation still works without an arrival animation.
    }

    document.addEventListener('click', (event) => {
        const link = event.target.closest('a[href]');
        if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (link.target === '_blank' || link.hasAttribute('download') || link.dataset.noTransition !== undefined) return;

        const destination = new URL(link.href, window.location.href);
        const sameDocument = destination.pathname === window.location.pathname
            && destination.search === window.location.search;
        if (destination.origin !== window.location.origin || (sameDocument && destination.hash)) return;
        if (sameDocument || leaving || reducedMotion.matches) return;

        event.preventDefault();
        leaving = true;
        window.MindmateSounds?.transition();
        const nextLabel = link.dataset.transitionLabel || link.getAttribute('aria-label') || link.textContent.trim() || '去往下一站';
        label.textContent = nextLabel.replace(/\s+/g, ' ');
        overlay.classList.remove('is-arriving');
        overlay.classList.add('is-leaving');
        try { sessionStorage.setItem('mindmate-transition', nextLabel); } catch { /* no-op */ }
        window.setTimeout(() => window.location.assign(destination.href), 730);
    });

    document.querySelectorAll(motionSelector).forEach((control) => {
        control.classList.add('motion-reactive');
        control.addEventListener('pointermove', (event) => {
            if (!finePointer.matches || reducedMotion.matches) return;
            const bounds = control.getBoundingClientRect();
            const x = ((event.clientX - bounds.left) / bounds.width - .5) * 5;
            const y = ((event.clientY - bounds.top) / bounds.height - .5) * 4;
            control.style.setProperty('--motion-x', x.toFixed(2) + 'px');
            control.style.setProperty('--motion-y', y.toFixed(2) + 'px');
        });
        control.addEventListener('pointerleave', () => {
            control.style.removeProperty('--motion-x');
            control.style.removeProperty('--motion-y');
        });
        control.addEventListener('pointerdown', (event) => {
            if (reducedMotion.matches || event.pointerType === 'touch' && event.isPrimary === false) return;
            control.querySelector('.motion-ripple')?.remove();
            const bounds = control.getBoundingClientRect();
            const ripple = document.createElement('span');
            ripple.className = 'motion-ripple';
            ripple.setAttribute('aria-hidden', 'true');
            ripple.style.setProperty('--motion-ripple-size', Math.max(bounds.width, bounds.height) * 2 + 'px');
            ripple.style.setProperty('--motion-ripple-x', event.clientX - bounds.left + 'px');
            ripple.style.setProperty('--motion-ripple-y', event.clientY - bounds.top + 'px');
            control.append(ripple);
            window.setTimeout(() => ripple.remove(), 580);
        });
    });

    window.addEventListener('pageshow', (event) => {
        if (!event.persisted) return;
        leaving = false;
        overlay.classList.remove('is-leaving', 'is-arriving');
    });
})();
