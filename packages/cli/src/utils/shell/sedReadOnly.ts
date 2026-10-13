/** Conservatively admit print/delete scripts and substitutions without exec/write flags. */
function isReadOnlySedExpression(expression: string): boolean {
  const script = expression.trim();
  if (/^(?:\d+|\$|\/(?:\\.|[^/\\])*\/)?(?:,(?:\d+|\$))?[! \t]*[pdq=]$/.test(script)) {
    return true;
  }
  if (!script.startsWith('s') || !script[1] || /[A-Za-z0-9\s\\]/.test(script[1])) {
    return false;
  }
  const delimiter = script[1];
  let separators = 0;
  let escaped = false;
  for (let index = 2; index < script.length; index++) {
    const character = script[index];
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === delimiter) {
      separators++;
      if (separators === 2) {
        return /^[gpIiMm0-9]*$/.test(script.slice(index + 1));
      }
    }
  }
  return false;
}

export function isReadOnlySedArguments(args: readonly string[]): boolean {
  const expressions: string[] = [];
  let positionalExpression = true;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '-e' || argument === '--expression') {
      const expression = args[++index];
      if (expression === undefined) return false;
      expressions.push(expression);
      positionalExpression = false;
    } else if (argument.startsWith('--expression=')) {
      expressions.push(argument.slice('--expression='.length));
      positionalExpression = false;
    } else if (argument === '--') {
      const remaining = args.slice(index + 1);
      if (positionalExpression && remaining[0]) expressions.push(remaining[0]);
      break;
    } else if (argument.startsWith('-')) {
      if (!/^-(?:[nEr]+|-quiet|-silent|-regexp-extended)$/.test(argument)) {
        return false;
      }
    } else if (positionalExpression) {
      expressions.push(argument);
      positionalExpression = false;
    }
  }
  return expressions.length > 0 && expressions.every(isReadOnlySedExpression);
}
