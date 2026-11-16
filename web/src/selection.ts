// Views exchange selection through this small store; they never import one another.
import { ref } from "vue";
export const selected = ref<{ kind: "run" | "card"; id: number } | null>(null);
export function openMarkPlate(key: string) {
  const match = /^(run|card):(\d+)$/.exec(key);
  if (!match) return;
  selected.value = { kind: match[1] as "run" | "card", id: Number(match[2]) };
  location.hash = "#/";
}
