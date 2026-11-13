// Input guards shared by the controllers and the product model Three small checks...

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

// Passwords - Passwords people pick first.
const COMMON_PASSWORDS = new Set([
    'password', 'passw0rd', 'pass', 'qwerty', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'letmein',
    'welcome', 'iloveyou', 'admin', 'administrator', 'login', 'abc', 'monkey', 'dragon', 'master',
    'sunshine', 'princess', 'football', 'baseball', 'superman', 'batman', 'trustno', 'whatever',
    'changeme', 'default', 'secret', 'computer', 'internet', 'mypassword', 'newpassword',
    'pharmacy', 'pharmatrack', 'pharmacist', 'cashier', 'owner', 'a2mpharmacy', 'a2m',
    'philippines', 'pilipinas', 'manila', 'angeles', 'pampanga', 'iloveyou', 'ilovemyself',
    'qazwsx', 'zaq', 'freedom', 'shadow', 'michael', 'jordan', 'mustang', 'hello', 'helloworld'
]);

const SEQUENCES = ['01234567890123456789', '98765432109876543210', 'abcdefghijklmnopqrstuvwxyz',
                   'zyxwvutsrqponmlkjihgfedcba', 'qwertyuiopasdfghjklzxcvbnm'];

function simplify(password) {
    return String(password)
        .toLowerCase()
        .replace(/[@4]/g, 'a').replace(/3/g, 'e').replace(/0/g, 'o').replace(/[$5]/g, 's')
        .replace(/[^a-z0-9]/g, '');
}

// Returns the problem with this password, or null if it is acceptable. ctx = { email
function passwordProblem(password, ctx = {}) {
    const pw = String(password ?? '');
    if (pw.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    if (pw.length > MAX_PASSWORD_LENGTH) return `Password must be ${MAX_PASSWORD_LENGTH} characters or fewer.`;

    // Compare the whole password AND its "stem"
    const base = simplify(pw);
    const stem = simplify(pw.toLowerCase().replace(/[^a-z]+$/, ''));
    if (COMMON_PASSWORDS.has(base) || (stem.length >= 4 && COMMON_PASSWORDS.has(stem))) {
        return 'That password is too common. Choose something harder to guess.';
    }

    const compact = pw.toLowerCase();
    const oneRepeatedCharacter = /^(.)\1+$/.test(compact);
    const onlyDigits = /^\d+$/.test(pw);
    const keyboardOrAlphabetRun = base.length >= 8 && SEQUENCES.some(s => s.includes(base));
    if (oneRepeatedCharacter || onlyDigits || keyboardOrAlphabetRun) {
        return 'Password is too simple. Use a mix of letters and numbers, not only digits or a keyboard pattern.';
    }

    // not the account's own email or name
    const lowered   = pw.toLowerCase();
    const emailName = String(ctx.email || '').toLowerCase().split('@')[0];
    if (emailName.length >= 4 && lowered.includes(emailName)) {
        return 'Password cannot contain the email of the account.';
    }
    const nameParts = String(ctx.name || '').toLowerCase().split(/[^a-z0-9]+/).filter(p => p.length >= 4);
    if (nameParts.some(p => lowered.includes(p))) {
        return 'Password cannot contain the name of the account.';
    }
    return null;
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
