import { SampleMatchViewer } from "@/components/SampleMatchViewer";


export default function Home() {
  return (
    <main className="page">
      <header className="page__header">
        <h1 className="page__title">
          PitchLens <span className="page__subtitle">MVP 2 · match simulator</span>
        </h1>
        <p className="page__note">
          Reproducible match simulation and a scripted demo. Teams, players, movement and events are entirely synthetic — not real match data.
        </p>
      </header>
      <SampleMatchViewer />
    </main>
  );
}
