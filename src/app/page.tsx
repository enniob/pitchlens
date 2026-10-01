import { SampleMatchViewer } from "@/components/SampleMatchViewer";
import { sampleFixture } from "@/match/fixture";

export default function Home() {
  return (
    <main className="page">
      <header className="page__header">
        <h1 className="page__title">
          PitchLens <span className="page__subtitle">MVP 1 · match viewer</span>
        </h1>
        <p className="page__note">
          {sampleFixture.title}. Teams, players, movement and events are entirely synthetic — not real match data.
        </p>
      </header>
      <SampleMatchViewer />
    </main>
  );
}
