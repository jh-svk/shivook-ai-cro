export default function PrivacyPolicy() {
  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "40px 20px", fontFamily: "system-ui, sans-serif", lineHeight: 1.6 }}>
      <h1>Privacy Policy — Shivook AI CRO</h1>
      <p><em>Last updated: April 2026</em></p>

      <h2>What data we collect</h2>
      <p>Shivook AI CRO collects the following data to operate A/B experiments on your storefront:</p>
      <ul>
        <li><strong>Hashed visitor IDs</strong> — a one-way hash of a randomly generated UUID stored in the visitor's browser. No personally identifiable information is included.</li>
        <li><strong>Session IDs</strong> — a randomly generated UUID per browser session. Not linked to any customer account.</li>
        <li><strong>Event types</strong> — page views, add-to-cart, checkout started, and purchase events. Events record only the event type, timestamp, and experiment assignment.</li>
        <li><strong>Revenue amounts</strong> — order totals for purchase events, used to calculate revenue per visitor. Not linked to individual customers.</li>
        <li><strong>Store analytics</strong> — aggregate metrics from connected data sources (Google Analytics 4, Microsoft Clarity) used to generate research insights.</li>
      </ul>

      <h2>What we do NOT collect</h2>
      <ul>
        <li>Names, email addresses, or any other personally identifiable information (PII)</li>
        <li>Raw customer data or Shopify customer records</li>
        <li>IP addresses</li>
        <li>Payment card details or financial information beyond aggregate revenue totals</li>
        <li>Browsing history outside of the merchant's own storefront</li>
      </ul>

      <h2>How data is stored</h2>
      <p>All data is stored in a PostgreSQL database hosted on Railway (Dallas, USA). Databases are encrypted at rest. Redis (also on Railway) is used for background job queuing only — no customer data is stored in Redis.</p>

      <h2>Data retention</h2>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={{ border: "1px solid #ccc", padding: "8px", textAlign: "left" }}>Plan</th>
            <th style={{ border: "1px solid #ccc", padding: "8px", textAlign: "left" }}>Event retention</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={{ border: "1px solid #ccc", padding: "8px" }}>Starter</td>
            <td style={{ border: "1px solid #ccc", padding: "8px" }}>3 months</td>
          </tr>
          <tr>
            <td style={{ border: "1px solid #ccc", padding: "8px" }}>Growth</td>
            <td style={{ border: "1px solid #ccc", padding: "8px" }}>12 months</td>
          </tr>
          <tr>
            <td style={{ border: "1px solid #ccc", padding: "8px" }}>Pro</td>
            <td style={{ border: "1px solid #ccc", padding: "8px" }}>Unlimited</td>
          </tr>
        </tbody>
      </table>

      <h2>How to request data deletion</h2>
      <p>To request deletion of all data associated with your store, email <a href="mailto:jacob@shivook.com">jacob@shivook.com</a> with your Shopify store domain. We will delete all experiment data, events, and results within 30 days.</p>
      <p>Uninstalling the app from your Shopify store triggers our GDPR shop deletion webhook, which removes all store-level data automatically within 48 hours.</p>

      <h2>GDPR compliance</h2>
      <p>Shivook AI CRO complies with Shopify's mandatory GDPR webhook requirements:</p>
      <ul>
        <li><strong>Customer data request</strong> — handled via <code>/webhooks/customers/data_request</code></li>
        <li><strong>Customer data deletion</strong> — handled via <code>/webhooks/customers/redact</code></li>
        <li><strong>Shop data deletion</strong> — handled via <code>/webhooks/shop/redact</code> (triggered on app uninstall)</li>
      </ul>
      <p>Because we do not collect PII, customer data requests typically result in a response confirming no PII is held.</p>

      <h2>Third-party services</h2>
      <ul>
        <li><strong>Anthropic Claude API</strong> — used for AI research synthesis and hypothesis generation. Store analytics data (aggregate metrics, no PII) is sent to the Claude API. Anthropic's privacy policy applies: <a href="https://www.anthropic.com/privacy">anthropic.com/privacy</a></li>
        <li><strong>Google Analytics 4</strong> — optional integration. If connected, aggregate GA4 metrics are pulled via the GA4 Data API. No raw user data is stored.</li>
        <li><strong>Microsoft Clarity</strong> — optional integration. If connected, aggregate engagement metrics are pulled from the Clarity API. No session recordings or heatmap images are stored.</li>
      </ul>

      <h2>Contact</h2>
      <p>For privacy questions or data deletion requests: <a href="mailto:jacob@shivook.com">jacob@shivook.com</a></p>
    </div>
  );
}
