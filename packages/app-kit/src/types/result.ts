// result.ts — the Result contract for anything that can fail (from
// soothing-booking; docs/CODE_STYLE.md §1). Success and failure share a
// `resultType` discriminator per family; failures carry a closed
// `errorCode` union.
// Moved from src/types/result.ts by task/app-kit (docs/apps-plan.md §5)
// — unchanged apart from the move.

export type ResultSuccess<ResultType extends string, DataType extends object> = {
  ok: true;
  resultType: ResultType;
  data: DataType;
  issues?: undefined;
  errorCode?: undefined;
  errorMessage?: undefined;
};

// "never" trick forces distribution to a union, so the type system knows which errors
// are returned for given function
export type ResultFailure<
  ResultType extends string,
  DataType extends object,
  ErrorCodeType extends string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- bare `any` is the distribution trick: it forces ErrorCodeType to distribute over the union
> = ErrorCodeType extends any
  ? {
      ok: false;
      resultType: ResultType;
      data?: DataType;
      issues?: Record<string, string>;
      errorCode: ErrorCodeType;
      errorMessage?: string;
    }
  : never;

export type Result<
  ResultType extends string,
  DataType extends object,
  ErrorCodeType extends string,
> = ResultSuccess<ResultType, DataType> | ResultFailure<ResultType, DataType, ErrorCodeType>;
