import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [
      { title: "Privacy Policy — ShopMyPin" },
      {
        name: "description",
        content:
          "How ShopMyPin collects, uses, shares and retains your personal data and your Pinterest data, and the rights you have under the DPDP Act, 2023.",
      },
    ],
  }),
  component: PrivacyPolicy,
});

/* A legal page is mostly long prose with a few dense tables. These two helpers
   exist so every table scrolls inside its own container on a phone rather than
   forcing the whole page sideways, and so the heading rhythm can't drift
   between sections. */
function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="mt-4 overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
        <thead className="bg-surface-2">
          <tr>
            {head.map((h) => (
              <th key={h} className="border-b border-border px-4 py-2.5 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function Row({ cells }: { cells: ReactNode[] }) {
  return (
    <tr className="border-b border-border/60 last:border-0 align-top">
      {cells.map((c, i) => (
        <td key={i} className="px-4 py-2.5">
          {c}
        </td>
      ))}
    </tr>
  );
}

function H2({ children }: { children: ReactNode }) {
  return <h2 className="mt-10 font-display text-xl font-bold">{children}</h2>;
}

function H3({ children }: { children: ReactNode }) {
  return <h3 className="mt-6 font-display text-base font-semibold">{children}</h3>;
}

function PrivacyPolicy() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10 text-sm leading-relaxed text-foreground">
      <Link
        to="/"
        className="mb-8 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> Back
      </Link>

      <h1 className="font-display text-3xl font-bold">Privacy Policy — ShopMyPin</h1>
      <p className="mt-2 text-muted-foreground">
        Last updated: 10 August 2026 · Effective from: 10 August 2026
      </p>

      <H2>Introduction</H2>
      <p className="mt-4">
        This Privacy Policy governs the use of ShopMyPin, a service operated under the domain
        shopmypin.com as part of the EarnKaro ecosystem.
      </p>
      <p className="mt-4">
        ShopMyPin is operated by Pouring Pounds India Private Limited (&ldquo;ShopMyPin&rdquo;,
        &ldquo;We&rdquo;, &ldquo;Our&rdquo;, &ldquo;Us&rdquo;), a company incorporated under the
        laws of India with its registered office at UM House, 2nd Floor, Sector 44, Gurgaon, Haryana
        122002, India. Pouring Pounds India Private Limited also operates EarnKaro (earnkaro.com),
        and is the Data Fiduciary in respect of all personal data processed through ShopMyPin.
      </p>
      <p className="mt-4">
        ShopMyPin is built exclusively for Pinterest Creators. It allows a Creator to connect their
        own Pinterest account, review the Pins and boards they have created, receive automated
        suggestions for products that appear in those Pins, and &mdash; where the Creator chooses to
        do so &mdash; attach a monetised destination link to their own Pins and publish a shoppable
        collection page.
      </p>
      <p className="mt-4">
        This Policy explains what personal data we collect, why we collect it, how we use and share
        it, how long we keep it, and what rights you have. It applies to shopmypin.com and to any
        ShopMyPin mobile or web application.
      </p>
      <p className="mt-4">
        ShopMyPin is not affiliated with, endorsed by, or sponsored by Pinterest, Inc.
        &ldquo;Pinterest&rdquo; and &ldquo;Pin&rdquo; are trademarks of Pinterest, Inc., used here
        only to describe interoperability.
      </p>
      <p className="mt-4">
        By creating a ShopMyPin account or connecting your Pinterest account, you agree to this
        Policy and to our{" "}
        <Link to="/terms" className="font-semibold text-primary hover:underline">
          Terms and Conditions
        </Link>
        .
      </p>

      <H2>1. Definitions</H2>
      <Table head={["Term", "Meaning"]}>
        <Row
          cells={[
            <strong key="t">Creator / You</strong>,
            "A natural person aged 18 or over who registers for ShopMyPin and connects a Pinterest account they own and control.",
          ]}
        />
        <Row
          cells={[
            <strong key="t">Personal Data</strong>,
            "Any data about an identifiable individual, as defined under the Digital Personal Data Protection Act, 2023 (“DPDP Act”).",
          ]}
        />
        <Row
          cells={[
            <strong key="t">Data Fiduciary</strong>,
            "Pouring Pounds India Private Limited, which determines the purpose and means of processing your Personal Data.",
          ]}
        />
        <Row
          cells={[
            <strong key="t">Data Principal</strong>,
            "You, the individual to whom the Personal Data relates.",
          ]}
        />
        <Row
          cells={[
            <strong key="t">Pinterest Data</strong>,
            "Data we receive from the Pinterest API under an access token you have authorised.",
          ]}
        />
        <Row
          cells={[
            <strong key="t">Access Token</strong>,
            "The OAuth 2.0 credential issued by Pinterest that permits ShopMyPin to call the Pinterest API on your behalf.",
          ]}
        />
        <Row
          cells={[
            <strong key="t">EarnKaro</strong>,
            "The affiliate platform operated by the same company at earnkaro.com, through which affiliate links are generated and earnings are settled.",
          ]}
        />
      </Table>

      <H2>2. How we authenticate you with Pinterest</H2>
      <p className="mt-4">
        We use Pinterest&rsquo;s OAuth 2.0 authorisation flow. We do not ask for, receive, collect,
        or store your Pinterest password. We do not collect, copy, or reuse Pinterest session
        cookies. We do not use scraping, headless browsers, or credential-based sign-in of any kind
        to access Pinterest.
      </p>
      <p className="mt-4">When you click &ldquo;Connect Pinterest&rdquo;:</p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>
          You are redirected to Pinterest&rsquo;s own domain, where Pinterest &mdash; not ShopMyPin
          &mdash; authenticates you.
        </li>
        <li>Pinterest shows you the specific permissions (scopes) ShopMyPin is requesting.</li>
        <li>
          If you approve, Pinterest returns an authorisation code to ShopMyPin, which we exchange
          for an Access Token and a refresh token.
        </li>
        <li>
          The Access Token and refresh token are encrypted at rest using AES-256, stored in
          access-controlled infrastructure, and are never written to logs, analytics tools, browser
          storage, or client-side code.
        </li>
      </ul>
      <p className="mt-4">
        The Access Token is the only Pinterest credential we hold. You can revoke it at any time
        &mdash; either from inside ShopMyPin (Settings &rarr; Disconnect Pinterest) or from
        Pinterest&rsquo;s own Apps settings page. Revocation immediately ends our ability to call
        the Pinterest API on your behalf, and triggers the deletion process described in Section 8.
      </p>

      <H2>3. Pinterest permissions we request, and why</H2>
      <p className="mt-4">
        We request only the scopes required by features you can see and use in the product. Each
        scope maps to a specific function:
      </p>
      <Table head={["Scope", "What it lets us do", "The feature it powers"]}>
        <Row
          cells={[
            <code key="s">boards:read</code>,
            "Read the list of boards you have created, with their names and Pin counts.",
            "The board list on your dashboard; the “Monetise a board” flow.",
          ]}
        />
        <Row
          cells={[
            <code key="s">pins:read</code>,
            "Read the Pins you have created — image URL, title, description, destination link, board.",
            "The Pin list on your dashboard; product matching against your Pin images.",
          ]}
        />
        <Row
          cells={[
            <code key="s">user_accounts:read</code>,
            "Read your Pinterest profile (handle, display name, avatar) and account-level analytics.",
            "Showing you which account is connected; the Pinterest SEO score on the Boost page.",
          ]}
        />
        <Row
          cells={[
            <code key="s">pins:write</code>,
            "Create a Pin, or update a Pin you own — specifically, to set its destination link.",
            "Attaching a monetised destination to a Pin you have approved; the “Create Pin” flow.",
          ]}
        />
        <Row
          cells={[
            <code key="s">boards:read_secret, pins:read_secret</code>,
            "Read boards and Pins you have marked secret on Pinterest.",
            "Allowing you to view and monetise your secret boards alongside your public ones.",
          ]}
        />
      </Table>
      <p className="mt-4">
        <strong>A specific note on secret boards.</strong> Secret boards are private to you. If you
        grant these scopes, ShopMyPin can read the Pins on them. We use that access only to display
        those Pins to you inside your own logged-in ShopMyPin account and to run product matching
        where you request it. We never make a secret board or a secret Pin public, and we never
        write to a secret Pin unless you explicitly approve that specific Pin. Secret Pin data is
        not included in any aggregate reporting, is not shown on your public store page, and is not
        shared with EarnKaro, affiliate networks, or retailers.
      </p>
      <p className="mt-4">
        If you would prefer ShopMyPin not to see your secret boards, you can decline those scopes on
        Pinterest&rsquo;s consent screen, or disconnect and reconnect. The rest of the product will
        continue to work on your public boards.
      </p>
      <p className="mt-4">
        We do not request advertising scopes, catalogue scopes, or access to other people&rsquo;s
        Pinterest accounts. We never access a Pinterest account other than the one you personally
        authorise.
      </p>

      <H2>4. What we write back to Pinterest</H2>
      <p className="mt-4">
        Every write to Pinterest is initiated by a deliberate action you take in the product.
        Specifically:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>
          <strong>Updating a Pin&rsquo;s destination link</strong> &mdash; only after you have
          reviewed the suggested product match for that specific Pin and approved it.
        </li>
        <li>
          <strong>Creating a Pin</strong> &mdash; only when you use the &ldquo;Create Pin&rdquo;
          flow and confirm publication.
        </li>
      </ul>
      <p className="mt-4">
        We do not run background jobs that modify your Pins. We do not schedule Pins. We do not
        repost, duplicate, or re-pin other people&rsquo;s content. We do not modify Pin titles,
        descriptions, or images without your action. If you use a bulk approval option, that option
        applies only to Pins you have been shown and have chosen to approve in that session, and you
        will always see the count of Pins that will be affected before any write occurs.
      </p>
      <p className="mt-4">
        You remain the author and publisher of your Pins. ShopMyPin acts on your instruction.
      </p>

      <H2>5. Personal Data we collect</H2>
      <H3>5.1 Data you give us</H3>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>Name, mobile number, email address.</li>
        <li>
          Payment settlement details (bank account name, account number, IFSC) and PAN, where
          required for payout and tax withholding.
        </li>
        <li>Any information you send us in support conversations.</li>
      </ul>

      <H3>5.2 Pinterest Data we receive under your Access Token</H3>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>Your Pinterest profile: user ID, handle, display name, profile image URL.</li>
        <li>Your boards: board ID, name, description, privacy status, Pin count.</li>
        <li>
          Your Pins: Pin ID, title, description, destination URL, board association, creation date,
          and the URL of the Pin image.
        </li>
        <li>
          Pin and account analytics made available by Pinterest, such as impressions and outbound
          clicks.
        </li>
      </ul>
      <p className="mt-4">
        We store Pinterest metadata only. We do not download, copy, or retain your Pin images on our
        servers. Images shown inside ShopMyPin are loaded directly from Pinterest&rsquo;s own
        content delivery network (i.pinimg.com) in your browser. Product matching is performed
        against the Pinterest-hosted image URL; where a transient copy is created in memory to run
        image analysis, it is discarded immediately after processing and is not written to
        persistent storage.
      </p>

      <H3>5.3 Data we generate</H3>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>Product matches suggested for each Pin, and whether you accepted or rejected them.</li>
        <li>
          Affiliate links created for you, and clicks, orders, sales and earnings attributed to
          those links.
        </li>
        <li>Your public store page content and its slug.</li>
      </ul>

      <H3>5.4 Technical data</H3>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>
          IP address, device and browser type, operating system, referring page, and in-app activity
          logs, collected for security, fraud prevention, debugging, and product improvement.
        </li>
      </ul>

      <H2>6. Purposes and lawful basis</H2>
      <p className="mt-4">
        We process your Personal Data on the basis of the consent you give when you register and
        when you authorise Pinterest, and where applicable for the legitimate uses permitted under
        Section 7 of the DPDP Act (such as compliance with law and prevention of fraud).
      </p>
      <Table head={["Purpose", "Data used"]}>
        <Row cells={["Authenticate you and maintain your account", "Contact data, Access Token"]} />
        <Row cells={["Display your boards and Pins inside the product", "Pinterest Data"]} />
        <Row
          cells={[
            "Detect products in your Pins and suggest matches",
            "Pin image URL, Pin title and description",
          ]}
        />
        <Row
          cells={[
            "Generate affiliate links and attribute earnings",
            "EarnKaro user ID, Pin ID, click and order data",
          ]}
        />
        <Row cells={["Update a Pin you have approved", "Access Token, Pin ID, destination URL"]} />
        <Row
          cells={[
            "Show you performance and earnings reporting",
            "Pinterest analytics, click and order data",
          ]}
        />
        <Row cells={["Settle payouts and meet tax obligations", "Bank details, PAN"]} />
        <Row
          cells={[
            "Prevent fraud, abuse and platform policy violations",
            "Technical data, activity logs",
          ]}
        />
        <Row
          cells={[
            "Respond to support requests and grievances",
            "Contact data, conversation records",
          ]}
        />
      </Table>

      <H2>7. Sharing your data</H2>
      <H3>7.1 EarnKaro</H3>
      <p className="mt-4">
        Registering for ShopMyPin also creates an EarnKaro user account for you, or links your
        existing one. Affiliate links are generated against that EarnKaro user ID, and your earnings
        are tracked and settled through EarnKaro&rsquo;s wallet and payout system. Because both
        services are operated by the same legal entity, Pouring Pounds India Private Limited, this
        is an internal transfer within a single Data Fiduciary rather than a disclosure to a third
        party.
      </p>
      <p className="mt-4">
        <strong>What crosses over:</strong> your identity and contact details, your EarnKaro user
        ID, the affiliate links created, and the click, order, sale and earnings data attributable
        to them.
      </p>
      <p className="mt-4">
        <strong>What does not cross over:</strong> your Pinterest Access Token, your Pinterest
        credentials, your secret boards and secret Pins, and Pinterest analytics data. Pinterest
        Data is not used to build marketing profiles on EarnKaro, is not merged into
        EarnKaro&rsquo;s advertising or remarketing audiences, and is not used to target you or
        anyone else with advertising.
      </p>

      <H3>7.2 Affiliate networks and retailers</H3>
      <p className="mt-4">
        When a shopper clicks a link on your store page, the affiliate network and the retailer
        receive the click and, if a purchase occurs, the transaction data needed to attribute
        commission. They receive your publisher identifier. They do not receive your Pinterest data,
        your Pin content, your boards, or your Pinterest handle.
      </p>

      <H3>7.3 Service providers</H3>
      <p className="mt-4">
        We use processors for cloud hosting, error monitoring, communications, and payments. They
        act on our instructions under contract, may not use your data for their own purposes, and
        are bound to confidentiality and security obligations at least as protective as this Policy.
      </p>

      <H3>7.4 Legal</H3>
      <p className="mt-4">
        We may disclose data where required by law, court order, or a lawful request from a
        government authority, or where necessary to establish, exercise or defend legal claims, or
        to investigate fraud or a breach of our Terms.
      </p>

      <H3>7.5 What we never do</H3>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>We do not sell your Personal Data or your Pinterest Data.</li>
        <li>We do not rent, licence, or trade Pinterest Data with data brokers.</li>
        <li>
          We do not use Pinterest Data to train general-purpose machine learning models, and we do
          not share it with third-party AI providers for model training.
        </li>
        <li>
          We do not use Pinterest Data for advertising targeting or to build advertising audiences.
        </li>
        <li>
          We do not access, read, or store the Pinterest data of anyone who has not personally
          authorised ShopMyPin.
        </li>
      </ul>

      <H2>8. Retention and deletion</H2>
      <Table head={["Data", "Retained for"]}>
        <Row
          cells={[
            "Pinterest Access Token and refresh token",
            "Until you disconnect Pinterest or delete your account. Deleted within 24 hours of either event.",
          ]}
        />
        <Row
          cells={[
            "Pinterest Data (boards, Pins, metadata, analytics)",
            "Until you disconnect Pinterest or delete your account. Deleted within 30 days of either event.",
          ]}
        />
        <Row
          cells={[
            "Account and contact data",
            "For as long as your account is active, then 30 days after deletion.",
          ]}
        />
        <Row
          cells={[
            "Transaction, earnings, invoicing and tax records",
            "Retained for the period required under Indian tax and company law, currently 8 years, and cannot be deleted earlier.",
          ]}
        />
        <Row
          cells={["Anonymised, aggregated statistics containing no identifier", "Indefinitely."]}
        />
      </Table>
      <p className="mt-4">
        <strong>Disconnecting Pinterest.</strong> You can disconnect at any time from Settings, or
        by revoking ShopMyPin&rsquo;s access from Pinterest. On disconnection we stop all API calls
        immediately, delete your tokens within 24 hours, and delete cached Pinterest metadata within
        30 days. Pins already updated on Pinterest remain as they are &mdash; they are your Pins and
        only you can change them back.
      </p>
      <p className="mt-4">
        <strong>Deleting your account.</strong> Write to us at the address in Section 12. We will
        delete your ShopMyPin data on the schedule above. Note that deleting ShopMyPin does not
        automatically close your EarnKaro account; tell us if you want both closed.
      </p>

      <H2>9. Security</H2>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>All traffic is served over TLS 1.2 or higher.</li>
        <li>
          Access Tokens and refresh tokens are encrypted at rest with AES-256, held separately from
          application data, and never exposed to the browser.
        </li>
        <li>
          Access to production data is restricted to authorised personnel on a need-to-know basis
          and is logged.
        </li>
        <li>We monitor for unauthorised access and maintain an incident response process.</li>
        <li>
          In the event of a personal data breach, we will notify the Data Protection Board of India
          and affected Data Principals as required under the DPDP Act.
        </li>
      </ul>
      <p className="mt-4">
        No system is perfectly secure. Please use a strong, unique password, do not share your
        account, and log out of shared devices.
      </p>

      <H2>10. Your rights</H2>
      <p className="mt-4">Under the DPDP Act you have the right to:</p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>
          <strong>Access</strong> &mdash; obtain a summary of the Personal Data we process about you
          and the processing activities undertaken.
        </li>
        <li>
          <strong>Correction and completion</strong> &mdash; have inaccurate or incomplete data
          corrected or updated.
        </li>
        <li>
          <strong>Erasure</strong> &mdash; request deletion of your Personal Data, subject to the
          legal retention periods in Section 8.
        </li>
        <li>
          <strong>Withdraw consent</strong> &mdash; at any time, with the same ease as it was given.
          Withdrawal is not retrospective and may prevent us from continuing to provide the service.
        </li>
        <li>
          <strong>Grievance redressal</strong> &mdash; raise a complaint with our Grievance Officer
          (Section 12) and, if unsatisfied, escalate to the Data Protection Board of India.
        </li>
        <li>
          <strong>Nominate</strong> &mdash; nominate another individual to exercise your rights in
          the event of your death or incapacity.
        </li>
      </ul>
      <p className="mt-4">
        To exercise any right, email support@earnkaro.com with &ldquo;ShopMyPin — Data
        Request&rdquo; in the subject line. We will respond within 30 days.
      </p>

      <H2>11. Other matters</H2>
      <p className="mt-4">
        <strong>Cookies.</strong> We use strictly necessary cookies to keep you signed in and to
        secure your session, and affiliate tracking cookies to attribute purchases made through your
        links. You can control cookies in your browser, but disabling them will break sign-in and
        earnings attribution.
      </p>
      <p className="mt-4">
        <strong>Children.</strong> ShopMyPin is available only to individuals aged 18 or over. We do
        not knowingly process the data of children. If we learn that a person under 18 has
        registered, we will close the account and delete the data.
      </p>
      <p className="mt-4">
        <strong>Cross-border transfers.</strong> Personal Data is processed and stored on
        infrastructure located in [SPECIFY REGION — e.g. India / Singapore]. Where data is processed
        outside India, we do so in accordance with Section 16 of the DPDP Act and only to countries
        not restricted by the Central Government.
      </p>
      <p className="mt-4">
        <strong>Changes.</strong> We will post any update here with a revised &ldquo;Last
        updated&rdquo; date. Where a change is material, we will notify you by email or in-product
        before it takes effect.
      </p>

      <H2>12. Contact and Grievance Officer</H2>
      <p className="mt-4">
        Grievance Officer (appointed under the DPDP Act, 2023 and the Information Technology
        (Intermediary Guidelines) Rules, 2021):
      </p>
      <p className="mt-4">
        Manish Saini, IT Manager
        <br />
        Pouring Pounds India Private Limited
        <br />
        UM House, 2nd Floor, Sector 44, Gurgaon, Haryana 122002, India
        <br />
        Email: support@earnkaro.com
      </p>
      <p className="mt-4">
        We acknowledge grievances within 24 hours and resolve them within 15 days.
      </p>
    </div>
  );
}
