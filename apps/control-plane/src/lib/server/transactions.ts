import { Result } from "better-result";
import type { Database } from "./database.ts";
import { DatabaseUnavailable, InvalidOperation, StorageUnavailable } from "./errors.ts";

export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export const transact = async <T, E>(
  database: Database,
  operation: (transaction: Transaction) => Promise<Result<T, E>>,
) => {
  let rejected: Result<T, E> | undefined;

  const result = await Result.tryPromise({
    try: () =>
      database.transaction(async (transaction) => {
        const outcome = await operation(transaction);

        if (outcome.isErr()) {
          rejected = outcome;
          // Drizzle rolls back on exceptions; an expected Result error must also abort writes.
          transaction.rollback();
        }

        return outcome;
      }),
    catch: (cause) =>
      cause instanceof InvalidOperation || cause instanceof StorageUnavailable
        ? cause
        : new DatabaseUnavailable({ message: "The database operation failed", cause }),
  });

  return rejected ?? result.andThen((operationResult) => operationResult);
};
