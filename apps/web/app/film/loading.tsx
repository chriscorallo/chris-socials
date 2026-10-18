import { RouteSkeleton } from "../components/RouteSkeleton";

// Instant, prefetched loading state for this route — see components/RouteSkeleton.tsx.
export default function Loading() {
  return <RouteSkeleton shape="list" maxWidth={880} label="Loading" />;
}
