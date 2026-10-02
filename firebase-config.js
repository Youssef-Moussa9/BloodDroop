// ============================================================================
// firebase-config.js
// ----------------------------------------------------------------------------
// Fill this in with YOUR OWN Firebase project keys (see README.md, step 1).
// These values are safe to publish in a public repo — they identify your
// Firebase project, they are not secret passwords. Your data is protected
// separately by the Firestore Security Rules you set in the Firebase console
// (also covered in README.md).
// ============================================================================

export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

// If this still says "YOUR_API_KEY", the app runs in local demo mode:
// nothing is shared between visitors, and everything disappears on refresh.
export const isConfigured = firebaseConfig.apiKey !== "YOUR_API_KEY";
