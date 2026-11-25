// Known disposable / temporary email domains and role-based local parts.
// Short curated lists — extend freely. Disposable = the address will work
// for a few minutes and then die, so it is never a real lead.
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'mailinator.net', 'mailinator.org', 'guerrillamail.com',
  'guerrillamail.net', 'guerrillamail.org', 'guerrillamailblock.com',
  'temp-mail.org', 'tempmail.com', 'temp-mail.io', '10minutemail.com',
  '10minutemail.net', 'throwawaymail.com', 'yopmail.com', 'yopmail.net',
  'sharklasers.com', 'getnada.com', 'fakemail.net', 'maildrop.cc',
  'trashmail.com', 'dispostable.com', 'mailnesia.com', 'tempail.com',
  'emailondeck.com', 'mohmal.com', 'mintemail.com', 'mytemp.email',
  'tempinbox.com', 'mailcatch.com', 'spamgourmet.com', 'burnermail.io',
  'anonymbox.com', 'jetable.org', 'tempemail.net', 'inboxkitten.com',
  'harakirimail.com', 'spambog.com', 'spambox.us', 'mailmetrash.com',
  'wegwerfmail.de', 'wegwerfmail.net', 'wegwerfmail.org', 'trash-mail.com',
  'getairmail.com', 'tempmailaddress.com', 'mailforspam.com',
]);

const ROLE_LOCAL_PARTS = new Set([
  'admin', 'administrator', 'support', 'help', 'info', 'contact', 'sales',
  'hello', 'team', 'office', 'billing', 'careers', 'jobs', 'press', 'media',
  'marketing', 'noreply', 'no-reply', 'postmaster', 'webmaster', 'abuse',
  'enquiries', 'enquiry', 'service', 'services', 'feedback', 'legal',
]);

// Free consumer providers — useful for analytics ("how much of the list is Gmail?").
const FREE_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.fr', 'outlook.com',
  'hotmail.com', 'hotmail.fr', 'live.com', 'msn.com', 'icloud.com',
  'me.com', 'aol.com', 'protonmail.com', 'proton.me', 'mail.com',
  'yandex.com', 'gmx.com', 'gmx.fr', 'zoho.com', 'tutanota.com',
]);

module.exports = { DISPOSABLE_DOMAINS, ROLE_LOCAL_PARTS, FREE_PROVIDERS };
