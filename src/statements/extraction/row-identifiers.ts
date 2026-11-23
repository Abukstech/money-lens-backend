/** Only accept explicitly labelled bankCode:account pairs on the transaction
 * row. Never derive bank codes from names or use a display name as identity. */
export function explicitRowIdentifiers(description: string) {
  const result: { accountIdentifier?: string; recipientIdentifier?: string } = {};
  const identify = (pattern: RegExp) => {
    const values = [...description.matchAll(pattern)].map((match) => `${match[1]}:${match[2]}`);
    return new Set(values).size === 1 ? values[0] : undefined;
  };
  const recipient = identify(
    /\b(?:RECIPIENT|BENEFICIARY|COUNTERPARTY)(?:\s+(?:ACCOUNT|IDENTIFIER))?\s*[:=]?\s*(\d{3,6}):(\d{10})\b/gi,
  );
  const account = identify(
    /\b(?:SOURCE ACCOUNT|OWN ACCOUNT|ACCOUNT IDENTIFIER)\s*[:=]?\s*(\d{3,6}):(\d{10})\b/gi,
  );
  if (recipient) result.recipientIdentifier = recipient;
  if (account) result.accountIdentifier = account;
  return result;
}
