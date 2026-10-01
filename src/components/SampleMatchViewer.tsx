"use client";

import { sampleFixture } from "@/match/fixture";
import { MatchViewer } from "./MatchViewer";

/** Builds the sample fixture in the browser instead of serialising ~300 KB of snapshots into the page. */
export function SampleMatchViewer() {
  return <MatchViewer fixture={sampleFixture} />;
}
