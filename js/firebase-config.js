// Firebase web config. Despite the name, `apiKey` is not a secret — Firebase is designed for
// this block to ship inside the page. Access is controlled by Firebase Auth and the Firestore
// security rules in firestore.rules, never by hiding these values.
export const firebaseConfig = {
  apiKey: 'AIzaSyBPLsPoLY5J01-NBruwuPF4zCyqutxLFfI',
  authDomain: 'mycounter-eb381.firebaseapp.com',
  projectId: 'mycounter-eb381',
  storageBucket: 'mycounter-eb381.firebasestorage.app',
  messagingSenderId: '265302897942',
  appId: '1:265302897942:web:bb7acd471748ef041e8c37',
};
