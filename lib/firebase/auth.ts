"use client";

import { onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import type { AuthUserProfile } from "@/lib/types";
import { auth, firebaseConfigured, googleProvider } from "@/lib/firebase/client";

function mapUser(user: User): AuthUserProfile {
  return {
    uid: user.uid,
    displayName: user.displayName ?? user.email ?? "Firebase User",
    email: user.email ?? "",
    photoURL: user.photoURL
  };
}

export function observeAuthUser(callback: (user: AuthUserProfile | null) => void) {
  if (!firebaseConfigured || !auth) {
    callback(null);
    return () => undefined;
  }

  return onAuthStateChanged(auth, (user) => {
    callback(user ? mapUser(user) : null);
  });
}

export async function signInWithGoogle() {
  if (!firebaseConfigured || !auth || !googleProvider) {
    throw new Error("Firebase 웹 설정값이 비어 있습니다. NEXT_PUBLIC_FIREBASE_* 환경 변수를 먼저 설정해 주세요.");
  }

  const credential = await signInWithPopup(auth, googleProvider);
  return mapUser(credential.user);
}

export async function signOutUser() {
  if (!auth) {
    return;
  }

  await signOut(auth);
}
