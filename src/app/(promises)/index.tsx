/**
 * (promises) route — the Treats/Promises ledger screen behind the Profile row
 * (NOT a tab; feed tab == home tab in MVP). Pair-private by RLS.
 */
import React from 'react';
import { PromisesScreen } from '@/features/promises/PromisesScreen';
export default function PromisesRoute() {
  return <PromisesScreen />;
}