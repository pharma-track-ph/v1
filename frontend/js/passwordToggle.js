// PharmaTrack - passwordToggle.js - ONE helper that puts the same show/hide "eye"...
const PasswordToggle = (() => {
    const SVG_OPEN = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
                     'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
                     'stroke-linejoin="round" aria-hidden="true"';

    // "eye" = the password is hidden, click to SHOW it
    const ICON_SHOW = `<svg ${SVG_OPEN}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    // "eye with a slash" = the password is visible, click to HIDE it
    const ICON_HIDE = `<svg ${SVG_OPEN}><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

    function setState(input, btn, visible) {
        input.type = visible ? 'text' : 'password';
        btn.innerHTML = visible ? ICON_HIDE : ICON_SHOW;
        const label = visible ? 'Hide password' : 'Show password';
        btn.setAttribute('aria-label', label);
        btn.setAttribute('title', label);
        btn.setAttribute('aria-pressed', String(visible));
    }

    function enhance(input) {
        if (!input || input.tagName !== 'INPUT' || input.type !== 'password') return;
        if (input.dataset.pwToggle === '1' || !input.parentNode) return;
        input.dataset.pwToggle = '1';

        const wrapper = document.createElement('div');
        wrapper.className = 'password-field';
        input.parentNode.insertBefore(wrapper, input);
        wrapper.appendChild(input);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'password-toggle';
        btn.tabIndex = 0;
        setState(input, btn, false);

        btn.addEventListener('click', () => {
            setState(input, btn, input.type === 'password');
            input.focus();
        });

        wrapper.appendChild(btn);
    }

    function enhanceAll(root = document) {
        if (root.nodeType === 1 && root.matches && root.matches('input[type="password"]')) enhance(root);
        if (root.querySelectorAll) root.querySelectorAll('input[type="password"]').forEach(enhance);
    }

    // A popup that closes must not leave a password VISIBLE for the next person who...
    function hideAllIn(container) {
        container.querySelectorAll('.password-field').forEach(w => {
            const input = w.querySelector('input');
            const btn   = w.querySelector('.password-toggle');
            if (input && btn && input.type === 'text') setState(input, btn, false);
        });
    }

    function start() {
        enhanceAll(document);

        new MutationObserver(mutations => {
            for (const m of mutations) {
                if (m.type === 'childList') {
                    m.addedNodes.forEach(node => { if (node.nodeType === 1) enhanceAll(node); });
                } else if (m.type === 'attributes') {
                    const t = m.target;
                    if (t.classList && t.classList.contains('modal-overlay') && !t.classList.contains('active')) hideAllIn(t);
                }
            }
        }).observe(document.body, {
            childList: true, subtree: true,
            attributes: true, attributeFilter: ['class']
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }

    return { enhance, enhanceAll };
})();

// The classic password rule: at least 10 characters with a capital letter, a number and a special character.
// passwordMissingList() names ONLY what is missing; passwordMissing() makes it one sentence (empty when nothing is missing).
// (The server applies the same rule and wording: passwordProblem() in backend/utils/inputGuards.js.)
function passwordMissingList(pw) {
    const v = String(pw ?? '');
    const need = [];
    if (v.length < 10)               need.push('10 characters');
    if (!/\p{Lu}/u.test(v))          need.push('1 capital letter');
    if (!/[0-9]/.test(v))            need.push('1 number');
    if (!/[^\p{L}\p{N}\s]/u.test(v)) need.push('1 special character');
    return need;
}

function passwordMissing(pw) {
    const need = passwordMissingList(pw);
    if (!need.length) return '';
    const list = need.length > 1 ? `${need.slice(0, -1).join(', ')} and ${need[need.length - 1]}` : need[0];
    return `You need at least ${list}.`;
}
