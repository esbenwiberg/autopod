interface JsonOutputOpts {
  json?: boolean;
}

export function withJsonOutput<T>(
  opts: JsonOutputOpts,
  data: T,
  humanRenderer: (data: T) => void,
): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    humanRenderer(data);
  }
}
