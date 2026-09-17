(() => {
    const overlay = document.getElementById('pageTransition');
    if (!overlay) return;

    const label = document.getElementById('transitionLabel');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
    const prefetchedPages = new Set();
    const leaveDelay = 285;
    const arriveDuration = 390;
    const motionSelector = [
        '.site-header a', '.button', '.path-item', '.chat-site-nav a',
        '.journal-header a', '.paper-footer button',
        '.complete-actions a', '.complete-actions button'
    ].join(', ');
    let leaving = false;

    const getInternalDestination = (link) => {
        if (!link || link.target === '_blank' || link.hasAttribute('download') || link.dataset.noTransition !== undefined) return null;
        const destination = new URL(link.href, window.location.href);
        const sameDocument = destination.pathname === window.location.pathname
            && destination.search === window.location.search;
        if (destination.origin !== window.location.origin || sameDocument) return null;
        return destination;
    };

    const prefetchPage = (link) => {
        const destination = getInternalDestination(link);
        if (!destination || prefetchedPages.has(destination.href)) return;
        prefetchedPages.add(destination.href);

        const hint = document.createElement('link');
        hint.rel = 'prefetch';
        hint.as = 'document';
        hint.href = destination.href;
        document.head.append(hint);
    };

    try {
        const arrivalLabel = sessionStorage.getItem('mindmate-transition');
        if (arrivalLabel && !reducedMotion.matches) {
            label.textContent = arrivalLabel;
            overlay.classList.add('is-arriving');
            sessionStorage.removeItem('mindmate-transition');
            window.setTimeout(() => overlay.classList.remove('is-arriving'), arriveDuration);
        }
    } catch {
        // Storage may be disabled; navigation still works without an arrival animation.
    }

    document.addEventListener('click', (event) => {
        const link = event.target.closest('a[href]');
        if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const destination = getInternalDestination(link);
        if (!destination || leaving || reducedMotion.matches) return;

        event.preventDefault();
        leaving = true;
        prefetchPage(link);
        window.MindmateSounds?.transition();
        const nextLabel = link.dataset.transitionLabel || link.getAttribute('aria-label') || link.textContent.trim() || '去往下一站';
        label.textContent = nextLabel.replace(/\s+/g, ' ');
        overlay.classList.remove('is-arriving');
        overlay.classList.add('is-leaving');
        try { sessionStorage.setItem('mindmate-transition', nextLabel); } catch { /* no-op */ }
        window.setTimeout(() => window.location.assign(destination.href), leaveDelay);
    });

    document.addEventListener('pointerover', (event) => {
        if (!finePointer.matches) return;
        prefetchPage(event.target.closest('a[href]'));
    }, { passive: true });
    document.addEventListener('focusin', (event) => prefetchPage(event.target.closest('a[href]')));
    document.addEventListener('touchstart', (event) => prefetchPage(event.target.closest('a[href]')), { passive: true });

    const prefetchNavigation = () => {
        document.querySelectorAll('a[href]').forEach(prefetchPage);
    };
    if ('requestIdleCallback' in window) {
        window.requestIdleCallback(prefetchNavigation, { timeout: 1200 });
    } else {
        window.setTimeout(prefetchNavigation, 800);
    }

    const canUseServiceWorker = location.protocol === 'https:'
        || location.hostname === 'localhost'
        || location.hostname === '127.0.0.1';
    if ('serviceWorker' in navigator && canUseServiceWorker) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/service-worker.js', { scope: '/' }).catch(() => {
                // Navigation still works through the regular network path.
            });
        }, { once: true });
    }

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
