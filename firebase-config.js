// ============================================================
// firebase-config.js — CampusLink Firebase Configuration
// ============================================================
// Replace the values below with your actual Firebase project credentials.
// Go to: Firebase Console > Project Settings > Your Apps > SDK Setup

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.11.0/firebase-storage.js";

const firebaseConfig = {
 apiKey: "AIzaSyBQ8vk3hiYKEBzKEyq23Bb9VYYjPWQk1aY",
  authDomain: "campuslink-ebeed.firebaseapp.com",
  projectId: "campuslink-ebeed",
  storageBucket: "campuslink-ebeed.firebasestorage.app",
  messagingSenderId: "843439503718",
  appId: "1:843439503718:web:d6302db678d7c5599cb0a7",
  measurementId: "G-CD7PCF251N"
};

const app        = initializeApp(firebaseConfig);
export const auth      = getAuth(app);
export const db        = getFirestore(app);
export const storage   = getStorage(app);
export const googleProvider = new GoogleAuthProvider();
