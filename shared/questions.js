/**
 * Cyber security question bank for live rounds.
 *
 * The server owns the correct answer (`answerIndex`). Public projections must
 * never include it until the question has been revealed.
 */
export const QUESTION_BANK = Object.freeze([
  {
    id: 'passphrase',
    category: 'Passwords',
    difficulty: 'easy',
    prompt: 'Which of these makes the strongest password?',
    options: [
      'A short word with one number',
      'A long random passphrase',
      'Your pet name and birth year',
      'The word password plus an exclamation mark',
    ],
    answerIndex: 1,
    explanation: 'Length and randomness matter more than clever substitutions.',
  },
  {
    id: 'suspicious-link',
    category: 'Phishing',
    difficulty: 'easy',
    prompt: 'An email asks you to click a link and confirm your password. What should you do?',
    options: [
      'Click it quickly before it expires',
      'Reply with your password',
      'Report it and do not click the link',
      'Forward it to your friends',
    ],
    answerIndex: 2,
    explanation: 'Legitimate providers do not ask for passwords by email. Report and delete it.',
  },
  {
    id: 'two-factor',
    category: 'Accounts',
    difficulty: 'easy',
    prompt: 'What does two-factor authentication add to a login?',
    options: [
      'A second password you reuse everywhere',
      'A second proof of identity, such as a code or key',
      'A longer username',
      'A public profile photo',
    ],
    answerIndex: 1,
    explanation: 'A stolen password alone is not enough when a second factor is required.',
  },
  {
    id: 'public-wifi',
    category: 'Networks',
    difficulty: 'easy',
    prompt: 'Why should you be careful on free public Wi-Fi?',
    options: [
      'It always costs money',
      'Traffic may be intercepted by others',
      'It disables your keyboard',
      'It deletes your files',
    ],
    answerIndex: 1,
    explanation: 'Untrusted networks can be monitored. Use HTTPS and a trusted VPN where possible.',
  },
  {
    id: 'updates',
    category: 'Devices',
    difficulty: 'easy',
    prompt: 'What is the safest approach to software updates?',
    options: [
      'Ignore them until something breaks',
      'Install them promptly, especially security updates',
      'Only update games',
      'Disable updates to save battery',
    ],
    answerIndex: 1,
    explanation: 'Updates close known vulnerabilities that attackers actively scan for.',
  },
  {
    id: 'password-reuse',
    category: 'Passwords',
    difficulty: 'easy',
    prompt: 'Why is reusing one password across many accounts risky?',
    options: [
      'It makes typing slower',
      'One breach can expose every account using it',
      'It uses too much memory',
      'Websites reject repeated passwords',
    ],
    answerIndex: 1,
    explanation: 'Attackers replay leaked credentials across other services, known as credential stuffing.',
  },
  {
    id: 'phishing-definition',
    category: 'Phishing',
    difficulty: 'easy',
    prompt: 'What is phishing?',
    options: [
      'A way to speed up your internet',
      'A scam that tricks people into revealing information',
      'A type of firewall rule',
      'A backup strategy',
    ],
    answerIndex: 1,
    explanation: 'Phishing uses convincing messages to steal credentials, money or access.',
  },
  {
    id: 'https-padlock',
    category: 'Browsing',
    difficulty: 'medium',
    prompt: 'What does the HTTPS padlock in a browser actually tell you?',
    options: [
      'The website is guaranteed to be honest',
      'The connection is encrypted',
      'The website has no trackers',
      'The website is government approved',
    ],
    answerIndex: 1,
    explanation: 'HTTPS protects traffic in transit. It does not prove the site is trustworthy.',
  },
  {
    id: 'social-engineering',
    category: 'Social Engineering',
    difficulty: 'medium',
    prompt: 'What does social engineering mainly exploit?',
    options: [
      'Weak encryption algorithms',
      'Human trust and urgency',
      'Unpatched operating systems',
      'Slow network cables',
    ],
    answerIndex: 1,
    explanation: 'Social engineering manipulates people rather than machines.',
  },
  {
    id: 'ransomware',
    category: 'Malware',
    difficulty: 'medium',
    prompt: 'What does ransomware usually do?',
    options: [
      'Encrypts files and demands payment',
      'Makes your screen brighter',
      'Backs up your data automatically',
      'Speeds up your computer',
    ],
    answerIndex: 0,
    explanation: 'Ransomware locks or encrypts data, then demands payment for recovery.',
  },
  {
    id: 'phishing-signs',
    category: 'Phishing',
    difficulty: 'medium',
    prompt: 'Which combination is the clearest phishing warning sign?',
    options: [
      'A polite greeting and a company logo',
      'Urgent language plus a mismatched sender address',
      'A long email signature',
      'An email sent during business hours',
    ],
    answerIndex: 1,
    explanation: 'Pressure to act fast and a sender address that does not match the brand are classic signs.',
  },
  {
    id: 'least-privilege',
    category: 'Access Control',
    difficulty: 'medium',
    prompt: 'What does the principle of least privilege mean?',
    options: [
      'Everyone gets administrator access',
      'Give only the access required for the task',
      'Never change any permissions',
      'Share one account across the team',
    ],
    answerIndex: 1,
    explanation: 'Limiting access reduces the damage a compromised account can cause.',
  },
  {
    id: 'backups',
    category: 'Data',
    difficulty: 'medium',
    prompt: 'What makes a backup strategy resilient against ransomware?',
    options: [
      'Keeping every backup on the same drive',
      'Offline or immutable copies that are tested',
      'Only backing up once a year',
      'Storing backups in the same folder as the data',
    ],
    answerIndex: 1,
    explanation: 'Attackers target connected backups. Offline copies and restore tests matter.',
  },
  {
    id: 'unknown-usb',
    category: 'Devices',
    difficulty: 'medium',
    prompt: 'You find an unknown USB drive in the car park. What should you do?',
    options: [
      'Plug it in to find the owner',
      'Hand it to IT or security without plugging it in',
      'Format it and keep it',
      'Share it with a colleague',
    ],
    answerIndex: 1,
    explanation: 'Dropped USB drives can carry malware or impersonation attacks.',
  },
  {
    id: 'brute-force',
    category: 'Passwords',
    difficulty: 'medium',
    prompt: 'What is a brute-force attack?',
    options: [
      'Guessing many passwords rapidly',
      'Physically breaking a laptop',
      'Deleting a network cable',
      'Sending phishing emails',
    ],
    answerIndex: 0,
    explanation: 'Automated guessing succeeds fastest against short or common passwords.',
  },
  {
    id: 'password-manager',
    category: 'Passwords',
    difficulty: 'medium',
    prompt: 'How does a password manager improve security?',
    options: [
      'It lets you reuse one password safely',
      'It generates and stores unique passwords',
      'It posts passwords to the cloud publicly',
      'It disables two-factor authentication',
    ],
    answerIndex: 1,
    explanation: 'Unique generated credentials remove password reuse and weak patterns.',
  },
  {
    id: 'sql-injection',
    category: 'Application Security',
    difficulty: 'hard',
    prompt: 'What is SQL injection?',
    options: [
      'Adding extra database rows by hand',
      'Inserting malicious input into unsanitised database queries',
      'Encrypting a database with a weak key',
      'Backing up a database over the network',
    ],
    answerIndex: 1,
    explanation: 'Untrusted input concatenated into queries can alter database commands.',
  },
  {
    id: 'zero-day',
    category: 'Vulnerabilities',
    difficulty: 'hard',
    prompt: 'What is a zero-day vulnerability?',
    options: [
      'A bug that only appears at midnight',
      'A flaw with no patch available yet',
      'A password that expires immediately',
      'A firewall that blocks all traffic',
    ],
    answerIndex: 1,
    explanation: 'Defenders have no fix when an unknown flaw is exploited.',
  },
  {
    id: 'mitm',
    category: 'Networks',
    difficulty: 'hard',
    prompt: 'What is a man-in-the-middle attack?',
    options: [
      'An attacker intercepts traffic between two parties',
      'A user sits between two monitors',
      'A server runs two operating systems',
      'A cable connects two switches',
    ],
    answerIndex: 0,
    explanation: 'The attacker relays or alters communications without either side noticing.',
  },
  {
    id: 'botnet',
    category: 'Malware',
    difficulty: 'hard',
    prompt: 'What is a botnet?',
    options: [
      'A network of compromised devices controlled remotely',
      'A secure backup appliance',
      'A type of password manager',
      'A firewall rule set',
    ],
    answerIndex: 0,
    explanation: 'Botnets coordinate infected machines for spam, DDoS and other attacks.',
  },
  {
    id: 'hashing',
    category: 'Cryptography',
    difficulty: 'hard',
    prompt: 'How does hashing differ from encryption?',
    options: [
      'Hashing is reversible with a key; encryption is not',
      'Hashing is one-way; encryption is reversible with a key',
      'They are exactly the same',
      'Hashing only works on images',
    ],
    answerIndex: 1,
    explanation: 'Good hashes cannot be reversed. Encryption is designed to be decrypted with the right key.',
  },
  {
    id: 'salting',
    category: 'Cryptography',
    difficulty: 'hard',
    prompt: 'What does salting a password hash do?',
    options: [
      'Adds random data before hashing so identical passwords differ',
      'Makes the password shorter',
      'Sends the password by email',
      'Encrypts the whole database',
    ],
    answerIndex: 0,
    explanation: 'Salts defeat precomputed tables and stop identical passwords matching in a breach.',
  },
  {
    id: 'supply-chain',
    category: 'Vulnerabilities',
    difficulty: 'hard',
    prompt: 'What is a supply-chain attack?',
    options: [
      'Stealing delivery vans',
      'Compromising software or a trusted vendor upstream',
      'Attacking a single password field',
      'Blocking all network traffic',
    ],
    answerIndex: 1,
    explanation: 'Attackers target a dependency or vendor so the compromise spreads to customers.',
  },
  {
    id: 'dns-spoofing',
    category: 'Networks',
    difficulty: 'hard',
    prompt: 'What does DNS spoofing do?',
    options: [
      'Speeds up domain lookups',
      'Redirects a domain name to a fake address',
      'Encrypts every DNS request',
      'Deletes domain records permanently',
    ],
    answerIndex: 1,
    explanation: 'Victims are sent to an attacker-controlled server while the domain looks correct.',
  },
  {
    id: 'csrf',
    category: 'Application Security',
    difficulty: 'expert',
    prompt: 'What characterises a cross-site request forgery (CSRF) attack?',
    options: [
      'Tricking a logged-in browser into sending an unwanted request',
      'Guessing a password repeatedly',
      'Flooding a server with traffic',
      'Reading a stolen hard drive',
    ],
    answerIndex: 0,
    explanation: 'CSRF abuses an existing session so the server sees a trusted request.',
  },
  {
    id: 'xss',
    category: 'Application Security',
    difficulty: 'expert',
    prompt: 'What does cross-site scripting (XSS) let an attacker do?',
    options: [
      'Inject script that runs in other users’ browsers',
      'Physically open a server rack',
      'Decrypt a hard drive without a key',
      'Change the speed of the network',
    ],
    answerIndex: 0,
    explanation: 'XSS runs attacker-controlled JavaScript in the context of a trusted site.',
  },
  {
    id: 'pass-the-hash',
    category: 'Access Control',
    difficulty: 'expert',
    prompt: 'What is a pass-the-hash attack?',
    options: [
      'Reusing a captured password hash without cracking it',
      'Sending a password twice',
      'Hashing a password in the browser',
      'Changing a password every day',
    ],
    answerIndex: 0,
    explanation: 'Some protocols accept the hash itself as authentication, so cracking is not required.',
  },
  {
    id: 'hsts',
    category: 'Browsing',
    difficulty: 'expert',
    prompt: 'What does HTTP Strict Transport Security (HSTS) enforce?',
    options: [
      'Browsers must use HTTPS for the site',
      'The site must use HTTP only',
      'Passwords must be shorter',
      'Cookies must be deleted hourly',
    ],
    answerIndex: 0,
    explanation: 'HSTS tells browsers to refuse insecure HTTP connections to that domain.',
  },
  {
    id: 'siem',
    category: 'Monitoring',
    difficulty: 'expert',
    prompt: 'What is the main purpose of a SIEM?',
    options: [
      'Collect and correlate security events for detection',
      'Store user photos',
      'Replace antivirus software completely',
      'Host public websites',
    ],
    answerIndex: 0,
    explanation: 'SIEM platforms centralise logs and alert on suspicious patterns across systems.',
  },
  {
    id: 'segmentation',
    category: 'Networks',
    difficulty: 'expert',
    prompt: 'Why is network segmentation valuable?',
    options: [
      'It limits how far an attacker can move sideways',
      'It makes every device public',
      'It removes the need for passwords',
      'It disables logging',
    ],
    answerIndex: 0,
    explanation: 'Segmentation narrows the blast radius and makes lateral movement harder.',
  },
  {
    id: 'rainbow-table',
    category: 'Cryptography',
    difficulty: 'expert',
    prompt: 'What is a rainbow table used for?',
    options: [
      'Cracking password hashes with precomputed values',
      'Colour-coding network cables',
      'Backing up encrypted files',
      'Blocking phishing emails',
    ],
    answerIndex: 0,
    explanation: 'Rainbow tables trade storage for speed. Salting hashes defeats them.',
  },
]);

const difficultyOrder = ['easy', 'medium', 'hard', 'expert'];

/**
 * The age band caps how advanced the question pool may get. Facilitators can
 * still choose an easier difficulty inside the band, but never a harder one.
 */
export const AGE_DIFFICULTY_LIMITS = Object.freeze({
  '10-15': ['easy', 'medium'],
  '15-20': ['easy', 'medium', 'hard'],
  adult: ['easy', 'medium', 'hard', 'expert'],
});

/** Pick an unused question for the requested difficulty, then widen the pool. */
export function pickQuestion({ difficulty = 'medium', ageGroup = '15-20', used = [] } = {}) {
  const allowed = AGE_DIFFICULTY_LIMITS[ageGroup] || difficultyOrder;
  const pool = QUESTION_BANK.filter((question) => allowed.includes(question.difficulty));
  const target = allowed.includes(difficulty) ? difficulty : allowed[allowed.length - 1];
  const usedSet = new Set(used);
  const exact = pool.filter((question) => question.difficulty === target);
  const exactUnused = exact.filter((question) => !usedSet.has(question.id));
  if (exactUnused.length) {
    return randomEntry(exactUnused);
  }

  const allUnused = pool.filter((question) => !usedSet.has(question.id));
  if (allUnused.length) {
    // Prefer a neighbouring difficulty before jumping across the whole band.
    const rank = difficultyOrder.indexOf(target);
    allUnused.sort((a, b) => {
      const distanceA = Math.abs(difficultyOrder.indexOf(a.difficulty) - rank);
      const distanceB = Math.abs(difficultyOrder.indexOf(b.difficulty) - rank);
      return distanceA - distanceB;
    });
    const bestDistance = Math.abs(difficultyOrder.indexOf(allUnused[0].difficulty) - rank);
    const nearest = allUnused.filter(
      (question) => Math.abs(difficultyOrder.indexOf(question.difficulty) - rank) === bestDistance,
    );
    return randomEntry(nearest);
  }

  return randomEntry(exact.length ? exact : pool);
}

function randomEntry(list) {
  return list[Math.floor(Math.random() * list.length)];
}

export function questionById(id) {
  return QUESTION_BANK.find((question) => question.id === id) || null;
}
