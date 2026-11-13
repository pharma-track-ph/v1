// Input guards shared by the controllers and the product model: plain text, passwords, profile pictures, emails.

const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 72;        // bcrypt only reads the first 72 bytes of a password
const AVATAR_MAX_CHARS    = 60000;     // the profile picture column is TEXT (about 64 KB)
const AVATAR_PATTERN      = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

// Plain text - The characters that start an HTML tag are refused
function plainTextProblem(label, value) {
    if (value === undefined || value === null) return null;
    if (/[<>]/.test(String(value))) return `${label} cannot contain the characters < or >.`;
    return null;
}

// Passwords - the classic rule: at least 10 characters with a capital letter, a number and a special character.
// Returns the sentence naming ONLY what is missing ("You need at least 1 capital letter."), or null when it passes.
// (The same rule and wording are in passwordMissing() in frontend/js/passwordToggle.js.)
function passwordProblem(password) {
    const pw = String(password ?? '');
    if (pw.length > MAX_PASSWORD_LENGTH) return `Password must be ${MAX_PASSWORD_LENGTH} characters or fewer.`;

    const need = [];
    if (pw.length < MIN_PASSWORD_LENGTH)     need.push(`${MIN_PASSWORD_LENGTH} characters`);
    if (!/\p{Lu}/u.test(pw))                 need.push('1 capital letter');
    if (!/[0-9]/.test(pw))                   need.push('1 number');
    if (!/[^\p{L}\p{N}\s]/u.test(pw))        need.push('1 special character');
    if (!need.length) return null;

    const list = need.length > 1 ? `${need.slice(0, -1).join(', ')} and ${need[need.length - 1]}` : need[0];
    return `You need at least ${list}.`;
}

// Profile picture - "No picture" (undefined, null or empty) is fine.
function avatarProblem(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') return 'Profile picture must be a PNG, JPEG or WebP image.';
    if (value.length > AVATAR_MAX_CHARS) return 'Profile picture is too large. Choose a smaller image.';
    if (!AVATAR_PATTERN.test(value)) return 'Profile picture must be a PNG, JPEG or WebP image.';
    return null;
}

// Email address - letters, digits and the usual symbols before the @, a real domain with a dot after it, at most 150 characters.
// This only checks the SHAPE; a code sent to the address is what proves it is real.
const EMAIL_LOCAL  = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const EMAIL_DOMAIN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;
const MAX_EMAIL_LENGTH = 150;

function emailProblem(value) {
    const email = String(value ?? '').trim();
    if (!email) return 'Email is required.';
    const parts = email.split('@');
    if (email.length > MAX_EMAIL_LENGTH || parts.length !== 2 || parts[0].length > 64
        || !EMAIL_LOCAL.test(parts[0]) || !EMAIL_DOMAIN.test(parts[1])) {
        return 'Enter a valid email address.';
    }
    return null;
}

module.exports = {
    plainTextProblem, passwordProblem, avatarProblem, emailProblem,
    MIN_PASSWORD_LENGTH, AVATAR_MAX_CHARS, MAX_EMAIL_LENGTH
};
