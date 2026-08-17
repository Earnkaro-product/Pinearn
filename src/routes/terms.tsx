import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms and Conditions — ShopMyPin" },
      {
        name: "description",
        content:
          "The terms governing your use of ShopMyPin — Pinterest permissions, coins, affiliate links and earnings, AI suggestions, and your responsibilities as a creator.",
      },
    ],
  }),
  component: TermsAndConditions,
});

function TermsAndConditions() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10 text-sm leading-relaxed text-foreground">
      <Link
        to="/"
        className="mb-8 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> Back
      </Link>

      <h1 className="font-display text-3xl font-bold">Terms and Conditions</h1>
      <p className="mt-2 text-muted-foreground">Last updated: 17 August 2026</p>

      <p className="mt-6">
        These Terms and Conditions (&ldquo;Terms&rdquo;) govern your access to and use of ShopMyPin
        (the &ldquo;Platform&rdquo;, &ldquo;Service&rdquo; or &ldquo;App&rdquo;), operated by
        Pouring Pounds India Private Limited (&ldquo;ShopMyPin&rdquo;, &ldquo;We&rdquo;,
        &ldquo;Our&rdquo;, &ldquo;Us&rdquo;), which also operates EarnKaro.com. By creating an
        account, connecting your Pinterest account, or otherwise using the Service, you
        (&ldquo;You&rdquo;, &ldquo;Your&rdquo;, &ldquo;User&rdquo; or &ldquo;Creator&rdquo;) agree
        to be bound by these Terms and by Our{" "}
        <Link to="/privacy" className="font-semibold text-primary hover:underline">
          Privacy Policy
        </Link>
        , which is incorporated into these Terms by reference. If You do not agree, do not use the
        Service.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">1. What ShopMyPin does</h2>
      <p className="mt-4">
        ShopMyPin is a tool for Pinterest creators. Subject to these Terms, the Service allows You
        to:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>
          connect Your Pinterest account and import Your public boards and the Pins You created;
        </li>
        <li>
          have the Service attempt to identify products shown in Your Pin images and suggest
          matching listings from supported retailers;
        </li>
        <li>attach affiliate links to Your Pins and to collections on Your storefront;</li>
        <li>
          generate suggested Pinterest SEO copy (Pin titles and descriptions, board names and
          descriptions) for Your review;
        </li>
        <li>publish a public storefront page listing Your collections and boards; and</li>
        <li>view reported impressions, clicks, conversions and estimated earnings.</li>
      </ul>
      <p className="mt-4">
        ShopMyPin is not affiliated with, endorsed by, or sponsored by Pinterest, Inc. Pinterest is
        a trademark of Pinterest, Inc.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">2. Eligibility</h2>
      <p className="mt-4">
        You must be at least 18 years old and legally capable of entering into a binding contract to
        use the Service. You must also meet Pinterest&rsquo;s own eligibility requirements and
        comply with Pinterest&rsquo;s Terms of Service. You represent that all information You
        provide to Us is true, accurate and current.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">3. Your account</h2>
      <ul className="mt-4 list-disc space-y-3 pl-6">
        <li>
          You sign in using Your mobile number and a one-time password. You are responsible for
          keeping access to that number and to Your device secure, and for all activity that occurs
          under Your account.
        </li>
        <li>
          One account per Creator. You may not sell, transfer, or share Your account, or create an
          account on behalf of another person without their authority.
        </li>
        <li>
          You must notify Us promptly at support@earnkaro.com if You believe Your account has been
          accessed without Your permission.
        </li>
      </ul>

      <h2 className="mt-10 font-display text-xl font-bold">
        4. Pinterest connection and permissions
      </h2>
      <p className="mt-4">
        The Service requires You to authorise it against Your Pinterest account. During that
        authorisation Pinterest will ask You to grant ShopMyPin permission to:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>see Your public boards, including group boards You join;</li>
        <li>create, update or delete Your public boards;</li>
        <li>see Your public Pins;</li>
        <li>create, update or delete Your public Pins; and</li>
        <li>see Your user account and followers.</li>
      </ul>
      <p className="mt-4">
        You expressly agree and acknowledge that, within those permissions, the Service is designed
        to operate only on:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>
          <strong>public</strong> boards and Pins. The Service does not import boards You have
          marked secret or protected, or the Pins held on them; and
        </li>
        <li>
          Pins You <strong>created</strong>. The Service does not import Pins You merely saved or
          repinned from another account.
        </li>
      </ul>
      <p className="mt-4">
        Where You use a feature that changes Your Pinterest content &mdash; for example applying a
        suggested title or description, or publishing a Pin &mdash; You authorise Us to make that
        specific change on Your behalf. We will not write to Your Pinterest account except as a
        result of an action You take in the Service.
      </p>
      <p className="mt-4">
        You may revoke ShopMyPin&rsquo;s access at any time from Your Pinterest account settings, or
        by disconnecting Pinterest in the Service&rsquo;s Settings screen. Revoking access will stop
        further synchronisation and will prevent most of the Service from functioning. Data already
        imported is handled as described in Our Privacy Policy.
      </p>
      <p className="mt-4">
        Your use of Pinterest remains governed by Pinterest&rsquo;s own Terms of Service, Business
        Terms of Service and Privacy Policy. Nothing in these Terms overrides them, and We are not
        responsible for Pinterest&rsquo;s acts, omissions, availability, or changes to its API or
        policies.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">5. Coins</h2>
      <ul className="mt-4 list-disc space-y-3 pl-6">
        <li>
          Certain features consume &ldquo;coins&rdquo;. Applying an AI-generated rewrite to one Pin
          costs one coin.
        </li>
        <li>
          Each Creator receives a weekly allowance of coins. The balance <strong>resets</strong> to
          the allowance at the start of each week (Monday, 00:00 UTC); it does not accumulate, and
          unspent coins do not carry over.
        </li>
        <li>
          Coins are a usage budget internal to the Service. They are not money, not virtual
          currency, not a stored-value instrument, and carry no cash value. They cannot be
          purchased, transferred, exchanged, redeemed or refunded, and confer no ownership or
          property right.
        </li>
        <li>
          We may change the allowance, the price of any action in coins, or discontinue coins
          entirely, at Our discretion.
        </li>
      </ul>

      <h2 className="mt-10 font-display text-xl font-bold">6. Affiliate links and earnings</h2>
      <ul className="mt-4 list-disc space-y-3 pl-6">
        <li>
          Affiliate links generated through the Service operate over the EarnKaro affiliate network
          and the programmes of participating retailers. Your entitlement to any commission is
          determined by the relevant retailer and affiliate programme, not by Us.
        </li>
        <li>
          Impressions, clicks, conversions, prices, commission rates and earnings shown in the
          Service are <strong>indicative estimates</strong>, reported to Us by Pinterest, retailers
          and third-party data providers. They may be delayed, incomplete or later revised. Figures
          are not confirmed until the relevant retailer confirms the underlying transaction.
        </li>
        <li>
          Commissions may be reduced, reversed, withheld or cancelled &mdash; including after being
          displayed to You &mdash; where an order is cancelled, returned, unpaid, duplicated,
          fraudulent, or rejected by the retailer or programme. You will not be entitled to amounts
          so reversed.
        </li>
        <li>
          Payment of confirmed earnings, including any minimum threshold, verification requirement,
          payment schedule, deduction and applicable tax withholding, is governed by the EarnKaro
          terms and payment policies applicable to Your account.
        </li>
        <li>
          You are solely responsible for all taxes payable on amounts You earn, and for any
          registration or filing that Your local law requires of You.
        </li>
        <li>
          <strong>
            We do not guarantee any level of traffic, clicks, conversions or earnings.
          </strong>{" "}
          Any figure, example or projection shown anywhere in the Service or in Our marketing is
          illustrative only and is not a promise of results.
        </li>
      </ul>

      <h2 className="mt-10 font-display text-xl font-bold">
        7. Disclosure of affiliate relationships
      </h2>
      <p className="mt-4">
        When You publish content containing affiliate links, You are responsible for disclosing that
        commercial relationship clearly and conspicuously, as required by applicable law and
        advertising codes (including, in India, the ASCI Guidelines for Influencer Advertising in
        Digital Media, and Pinterest&rsquo;s own paid-partnership and community requirements). You
        are responsible for ensuring Your content is not misleading about price, availability,
        sponsorship or endorsement.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">8. AI-generated suggestions</h2>
      <ul className="mt-4 list-disc space-y-3 pl-6">
        <li>
          The Service uses automated systems, including third-party AI models and image-recognition
          and visual-search providers, to propose product matches and SEO copy. These outputs are{" "}
          <strong>suggestions for Your review</strong>, generated automatically and without human
          verification.
        </li>
        <li>
          Suggestions may be inaccurate, incomplete, outdated, or may identify the wrong product.
          Prices and stock information may be stale. You must review a suggestion before You apply,
          publish or attach it.
        </li>
        <li>
          Once You approve or publish a suggestion, the resulting content is Your content and You
          are responsible for it, including its accuracy and its compliance with law,
          Pinterest&rsquo;s policies and any retailer&rsquo;s requirements.
        </li>
        <li>
          We make no representation that any suggestion will improve Your search ranking,
          distribution, reach or income.
        </li>
      </ul>

      <h2 className="mt-10 font-display text-xl font-bold">9. Your content and licence to Us</h2>
      <p className="mt-4">
        You retain all rights You hold in Your Pins, images, boards, text and other content
        (&ldquo;Your Content&rdquo;). You grant Us a non-exclusive, worldwide, royalty-free licence
        to host, store, reproduce, process, adapt and transmit Your Content solely to the extent
        necessary to operate and provide the Service to You &mdash; including sending Your Pin
        images and metadata to the third-party providers described in Clause 12 in order to detect
        products, find matching listings and generate copy, and displaying Your Content on Your
        public storefront page. This licence ends when You delete the relevant content or Your
        account, except to the extent We must retain it to comply with law or resolve a dispute.
      </p>
      <p className="mt-4">You represent and warrant that:</p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>
          You own or are licensed to use Your Content, and its use through the Service does not
          infringe any third party&rsquo;s intellectual property, privacy or publicity rights; and
        </li>
        <li>
          Your Content is not unlawful, defamatory, obscene, deceptive, or in breach of
          Pinterest&rsquo;s community guidelines.
        </li>
      </ul>

      <h2 className="mt-10 font-display text-xl font-bold">10. Acceptable use</h2>
      <p className="mt-4">You agree that You will not:</p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>
          generate clicks, impressions or conversions by artificial, automated, incentivised,
          misleading or fraudulent means, including self-clicking, bots, click farms, cookie
          stuffing, or undisclosed redirects;
        </li>
        <li>
          use the Service in connection with content that is unlawful, infringing, adult, hateful,
          or otherwise prohibited by Pinterest or by an applicable retailer programme;
        </li>
        <li>
          misrepresent a product, price, discount, availability, or Your relationship with any
          brand;
        </li>
        <li>
          attempt to access another User&rsquo;s account or data, or any part of Our systems You are
          not authorised to access;
        </li>
        <li>
          scrape, reverse engineer, decompile, or attempt to derive the source code of the Service,
          or circumvent any rate limit, quota or security measure;
        </li>
        <li>
          resell, sublicense or make the Service available to any third party as Your own service;
          or
        </li>
        <li>use the Service to violate any applicable law or any third party&rsquo;s rights.</li>
      </ul>

      <h2 className="mt-10 font-display text-xl font-bold">11. Your public storefront</h2>
      <p className="mt-4">
        If You publish a storefront, the page and the content You place on it are publicly
        accessible to anyone with the link and may be indexed by search engines. You are responsible
        for what You choose to publish there. We may remove a storefront or any content on it that
        We reasonably believe breaches these Terms or applicable law.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">12. Third-party services</h2>
      <p className="mt-4">
        The Service depends on third parties, including Pinterest, participating retailers and
        affiliate networks, visual-search and image-recognition providers, AI model providers,
        keyword and trends data providers, and cloud hosting and database providers. Their
        performance, availability, pricing and policies are outside Our control. Your use of a third
        party&rsquo;s own website or service (for example, clicking through to a retailer) is
        governed by that party&rsquo;s terms, and We are not a party to, and accept no
        responsibility for, any transaction between You and any third party.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">13. Intellectual property</h2>
      <p className="mt-4">
        The Service, including its software, design, text, graphics, logos and the ShopMyPin and
        EarnKaro marks, is owned by Us or Our licensors and is protected by intellectual property
        law. Except for the limited right to use the Service under these Terms, no licence or right
        is granted to You. You may not use Our marks without Our prior written consent.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">14. Availability and changes</h2>
      <p className="mt-4">
        The Service is provided on an evolving basis. We may add, change, suspend or withdraw any
        feature, quota or limit at any time, and may carry out maintenance that interrupts
        availability. We do not guarantee that the Service will be uninterrupted, timely, secure or
        error-free, or that any defect will be corrected.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">15. Suspension and termination</h2>
      <ul className="mt-4 list-disc space-y-3 pl-6">
        <li>
          You may stop using the Service at any time, disconnect Pinterest, and request deletion of
          Your account by writing to support@earnkaro.com.
        </li>
        <li>
          We may suspend or terminate Your access, withhold unconfirmed earnings, or remove content,
          with or without notice, where We reasonably believe You have breached these Terms, engaged
          in fraudulent or abusive activity, or where required by law, by Pinterest, or by an
          affiliate programme.
        </li>
        <li>
          Clauses which by their nature should survive termination &mdash; including Clauses 6, 9,
          13, 16, 17, 18 and 19 &mdash; will survive.
        </li>
      </ul>

      <h2 className="mt-10 font-display text-xl font-bold">16. Disclaimer of warranties</h2>
      <p className="mt-4">
        To the maximum extent permitted by law, the Service is provided &ldquo;as is&rdquo; and
        &ldquo;as available&rdquo;, without warranty of any kind, whether express, implied or
        statutory, including any implied warranty of merchantability, fitness for a particular
        purpose, accuracy, or non-infringement. We do not warrant the accuracy of any product match,
        price, stock status, metric, keyword, earnings figure or AI-generated suggestion.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">17. Limitation of liability</h2>
      <p className="mt-4">
        To the maximum extent permitted by law, We will not be liable for any indirect, incidental,
        special, consequential or punitive damages, or for any loss of profit, revenue, commission,
        goodwill, data, followers or business opportunity, however caused and on any theory of
        liability, arising out of or in connection with Your use of or inability to use the Service.
      </p>
      <p className="mt-4">
        Our total aggregate liability arising out of or in connection with these Terms or the
        Service will not exceed the total confirmed earnings actually paid to You through the
        Service in the three (3) months immediately preceding the event giving rise to the claim, or
        INR 1,000, whichever is higher. Nothing in these Terms excludes or limits any liability that
        cannot lawfully be excluded or limited.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">18. Indemnity</h2>
      <p className="mt-4">
        You agree to indemnify, defend and hold harmless Pouring Pounds India Private Limited, its
        affiliates, directors, officers and employees from and against any claim, demand,
        proceeding, loss, liability, damage, cost or expense (including reasonable legal fees)
        arising out of or related to Your Content, Your use of the Service, Your breach of these
        Terms or of any applicable law or third-party right, or Your failure to disclose an
        affiliate relationship as required by Clause 7.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">19. Governing law and disputes</h2>
      <p className="mt-4">
        These Terms are governed by the laws of India. Subject to the following, the courts at
        Gurugram, Haryana will have exclusive jurisdiction over any dispute arising out of or in
        connection with these Terms. The parties will first attempt in good faith to resolve any
        dispute amicably by written notice to the other party.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">20. Changes to these Terms</h2>
      <p className="mt-4">
        We may amend these Terms from time to time. The amended Terms will be posted on this page
        with an updated &ldquo;Last updated&rdquo; date, and take effect when posted. Where a change
        is material We will make reasonable efforts to notify You in the Service. Your continued use
        of the Service after a change constitutes Your acceptance of the amended Terms. You should
        review this page periodically.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">21. Miscellaneous</h2>
      <ul className="mt-4 list-disc space-y-3 pl-6">
        <li>
          These Terms, together with the Privacy Policy, are the entire agreement between You and Us
          in respect of the Service.
        </li>
        <li>
          If any provision is held unenforceable, the remaining provisions continue in full force.
        </li>
        <li>
          Our failure to enforce any right is not a waiver of it. You may not assign these Terms; We
          may assign them to an affiliate or successor.
        </li>
        <li>
          Nothing in these Terms creates a partnership, joint venture, agency or employment
          relationship between You and Us. You act as an independent party.
        </li>
      </ul>

      <h2 className="mt-10 font-display text-xl font-bold">22. Grievance officer and contact</h2>
      <p className="mt-4">
        For any question, complaint or grievance regarding these Terms or the Service, You may
        contact the officer designated under the Information Technology Act, 2000 and the rules made
        thereunder. We will use reasonable efforts to respond promptly.
      </p>
      <p className="mt-4">
        Name: Manish Saini, IT Manager
        <br />
        Pouring Pounds India Private Limited,
        <br />
        UM House, 2nd Floor, Gurgaon, Sector 44, 122002, Haryana, India
        <br />
        Email: support@earnkaro.com
      </p>
    </div>
  );
}
