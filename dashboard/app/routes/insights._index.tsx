// Insights > Fix first (BAC-67 placeholder). Feature 7 (BAC-74) replaces it with the ranked list.
import { Lightbulb } from "lucide-react";
import { Card, Empty } from "~/components/ui";

export default function FixFirst() {
  return (
    <Card>
      <Empty icon={<Lightbulb className="h-5 w-5" />} title="Nothing to rank yet." />
    </Card>
  );
}
