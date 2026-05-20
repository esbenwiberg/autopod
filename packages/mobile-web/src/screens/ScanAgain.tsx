export function ScanAgain(): JSX.Element {
  return (
    <main>
      <h1>Re-pair this phone</h1>
      <p className="warn">Your token is missing or expired.</p>
      <p>
        On the laptop, run:
        <br />
        <code>ap mobile pair</code>
      </p>
      <p className="muted">
        Then scan the QR code with your phone's camera. The page will reload with a fresh token.
      </p>
    </main>
  );
}
