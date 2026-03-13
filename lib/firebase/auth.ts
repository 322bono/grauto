"use client";

import { onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import type { AuthUserProfile } from "@/lib/types";
import { auth, googleProvider } from "@/lib/firebase/client";

function mapUser(user: User): AuthUserProfile {
  return {
    uid: user.uid,
    displayName: user.displayName ?? user.email ?? "Firebase User",
    email: user.email ?? "",
    photoURL: user.photoURL
  };
}

export function observeAuthUser(callback: (user: AuthUserProfile | null) => void) {
  return onAuthStateChanged(auth, (user) => {
    callback(user ? mapUser(user) : null);
  });
}

export async function signInWithGoogle() {
  const credential = await signInWithPopup(auth, googleProvider);
  return mapUser(credential.user);
}

export async function signOutUser() {
  await signOut(auth);
}
