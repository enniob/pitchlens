import { SampleMatchViewer } from "@/components/SampleMatchViewer";

export default function Home() {
  return (
    <main className="page">
      <h1 className="visually-hidden">PitchLens: synthetic football match viewer</h1>
      <SampleMatchViewer />
    </main>
  );
}
