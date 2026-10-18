import { RouteSkeleton } from "../../components/RouteSkeleton";

// Instant, prefetched loading state for this route — see components/RouteSkeleton.tsx.
export default function Loading() {
  return <RouteSkeleton shape="cards" maxWidth={1040} label="Loading videos" />;
}
