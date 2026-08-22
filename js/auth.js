// Client-side account gate only — this is a static, backend-less PWA (main brief §3), so
// there is no server to verify a real credential against. This does not protect the data
// from anyone who can read the source; it exists to keep the two people using this on a
// shared device from casually seeing each other's log/targets/weight, not as real auth.
const ACCOUNTS = {
  yannick: 'Mycounter@01',
  manshini: 'Mycounter@01',
};

const SESSION_KEY = 'calorie-tracker-session-user';

export function attemptLogin(username, password) {
  const key = username.trim().toLowerCase();
  if (ACCOUNTS[key] && ACCOUNTS[key] === password) {
    localStorage.setItem(SESSION_KEY, key);
    return key;
  }
  return null;
}

export function getSessionUser() {
  const user = localStorage.getItem(SESSION_KEY);
  return ACCOUNTS[user] ? user : null;
}

export function logout() {
  localStorage.removeItem(SESSION_KEY);
}

export function accountLabel(user) {
  return user === 'yannick' ? 'Yannick' : user === 'manshini' ? 'Manshini' : user;
}
