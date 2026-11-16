/** Keep the same event ID after an uncertain result; a confirmed result or edit starts a new submission. */
export function createSubmission(makeId: () => string = () => crypto.randomUUID()) {
  let previous: { body: string; id: string } | undefined;
  return {
    prepare<T extends object>(body: T): T & { id: string } {
      const serialized = JSON.stringify(body);
      if (!previous || previous.body !== serialized) previous = { body: serialized, id: makeId() };
      return { ...body, id: previous.id };
    },
    accepted() {
      previous = undefined;
    },
  };
}
