import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";

import { useGoBack } from "@/hooks/use-go-back";

export const Route = createFileRoute("/terms")({
  head: () => ({
    meta: [
      { title: "Terms and Conditions — ShopMyPin" },
      {
        name: "description",
        content:
          "The terms governing your use of ShopMyPin — Pinterest permissions, automated product matching, affiliate links and earnings, and your responsibilities as a Pinterest creator.",
      },
    ],
  }),
  component: TermsAndConditions,
});

function TermsAndConditions() {
  // Reached from the landing page, auth, onboarding and each other — back
  // returns to whichever of those the reader came from.
  const goBack = useGoBack({ to: "/" });

  return (
    <div className="mx-auto max-w-3xl px-6 py-10 text-sm leading-relaxed text-foreground">
      <button
        type="button"
        onClick={goBack}
        className="mb-8 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> Back
      </button>

      <h1 className="font-display text-3xl font-bold">Terms and Conditions</h1>
      <p className="mt-2 text-muted-foreground">
        Last updated: 17 August 2026
        <br />
        Effective from: [DEPLOY DATE]
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">Introduction</h2>
      <p className="mt-4">
        These Terms and Conditions (&ldquo;Terms&rdquo;) govern your access to and use of ShopMyPin
        (the &ldquo;Service&rdquo;), available at shopmypin.com.
      </p>
      <p className="mt-4">
        ShopMyPin is part of the EarnKaro ecosystem and is operated by Pouring Pounds India Private
        Limited (&ldquo;ShopMyPin&rdquo;, &ldquo;We&rdquo;, &ldquo;Our&rdquo;, &ldquo;Us&rdquo;), a
        company incorporated in India with its registered office at UM House, 2nd Floor, Sector 44,
        Gurgaon, Haryana 122002. The same company operates EarnKaro (earnkaro.com).
      </p>
      <p className="mt-4">
        ShopMyPin exists for one audience: Pinterest Creators who want to earn from Pins they have
        created.
      </p>
      <p className="mt-4">
        By creating an account, connecting your Pinterest account, or otherwise using the Service,
        you (&ldquo;You&rdquo;, &ldquo;Your&rdquo;, &ldquo;Creator&rdquo;) agree to these Terms and
        to our{" "}
        <Link to="/privacy" className="font-semibold text-primary hover:underline">
          Privacy Policy
        </Link>
        , which is incorporated by reference. If you do not agree, do not use the Service.
      </p>
      <p className="mt-4">
        ShopMyPin is not affiliated with, endorsed by, sponsored by, or otherwise connected to
        Pinterest, Inc. &ldquo;Pinterest&rdquo;, &ldquo;Pin&rdquo; and related marks belong to
        Pinterest, Inc.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">1. What ShopMyPin does</h2>
      <p className="mt-4">Subject to these Terms, the Service allows you to:</p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>
          Connect a Pinterest account that you own and control, using Pinterest&rsquo;s OAuth 2.0
          authorisation flow.
        </li>
        <li>Import and view the boards and Pins you have created.</li>
        <li>
          Have the Service attempt to identify products shown in your Pin images and suggest
          matching retailer products.
        </li>
        <li>
          Review those suggestions and, for each Pin you approve, attach a monetised destination
          link.
        </li>
        <li>Publish a public store page listing the collections you have created.</li>
        <li>
          Track clicks, orders and affiliate earnings, and withdraw those earnings through EarnKaro.
        </li>
      </ul>
      <p className="mt-4">
        The Service is provided on an &ldquo;as available&rdquo; basis. Features may change, and we
        may add, modify or withdraw any part of the Service.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">2. Eligibility</h2>
      <p className="mt-4">To use ShopMyPin you must:</p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>
          Be at least 18 years of age and legally capable of entering a binding contract under the
          Indian Contract Act, 1872.
        </li>
        <li>Own, or be lawfully authorised to manage, the Pinterest account you connect.</li>
        <li>
          Not be barred from receiving the Service under Indian law, or suspended or removed from
          Pinterest or from EarnKaro.
        </li>
      </ul>
      <p className="mt-4">
        You may hold only one ShopMyPin account unless we agree otherwise in writing.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">3. Your relationship with EarnKaro</h2>
      <p className="mt-4">
        Registering for ShopMyPin creates an EarnKaro account for you, or links your existing
        EarnKaro account. This is how affiliate links are generated and how your earnings are tracked
        and paid.
      </p>
      <p className="mt-4">By registering for ShopMyPin you agree that:</p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>An EarnKaro user account may be created in your name using the details you provide.</li>
        <li>
          Affiliate links generated through ShopMyPin are issued against your EarnKaro user ID.
        </li>
        <li>Your earnings accrue in, and are withdrawn from, the EarnKaro wallet.</li>
      </ul>
      <p className="mt-4">
        EarnKaro&rsquo;s Terms and Conditions also apply to the affiliate, commission and payout
        aspects of the Service. Where the two documents conflict on a matter specific to
        ShopMyPin&rsquo;s Pinterest features, these Terms prevail; on matters of affiliate commission
        and payment, EarnKaro&rsquo;s terms prevail.
      </p>
      <p className="mt-4">
        You can ask us to close either account. Closing ShopMyPin does not automatically close
        EarnKaro; tell us if you want both closed.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">
        4. Connecting Pinterest &mdash; your responsibilities
      </h2>
      <p className="mt-4">When you connect Pinterest, you confirm and agree that:</p>
      <ul className="mt-4 list-disc space-y-3 pl-6">
        <li>
          <strong>4.1 The account is yours.</strong> You will not connect an account belonging to
          another person or entity without their documented authority.
        </li>
        <li>
          <strong>4.2</strong> Your use of ShopMyPin must comply with Pinterest&rsquo;s own rules,
          including Pinterest&rsquo;s Terms of Service, Community Guidelines, Merchant Guidelines,
          and Commercial and Branded Content Guidelines. Those rules apply to you as the Pin author
          regardless of what ShopMyPin permits.
        </li>
        <li>
          <strong>4.3</strong> You are responsible for disclosing affiliate relationships. Pinterest
          requires that paid, sponsored, and affiliate content be disclosed, and Indian advertising
          rules (the ASCI Guidelines for Influencer Advertising) require clear and prominent
          disclosure of a material connection. Where ShopMyPin provides disclosure labelling, you
          must not remove or obscure it. Where you write your own Pin descriptions, the disclosure is
          your responsibility.
        </li>
        <li>
          <strong>4.4</strong> You remain the author and publisher of every Pin. ShopMyPin acts only
          on your instruction. You are responsible for the content of your Pins, including images,
          descriptions, and destination links.
        </li>
        <li>
          <strong>4.5</strong> You will not use the Service to violate any third party&rsquo;s
          intellectual property, publicity, or privacy rights. You must have the right to use every
          image you Pin.
        </li>
        <li>
          <strong>4.6</strong> You accept that Pinterest may independently suspend, restrict, or
          remove your account, your Pins, or ShopMyPin&rsquo;s API access, and that we have no
          control over and no liability for such decisions.
        </li>
      </ul>

      <h2 className="mt-10 font-display text-xl font-bold">
        5. Actions taken on your Pinterest account
      </h2>
      <ul className="mt-4 list-disc space-y-3 pl-6">
        <li>
          <strong>5.1</strong> ShopMyPin writes to your Pinterest account only when you instruct it
          to. A write occurs when you approve a product match for a specific Pin, or when you create
          a Pin through the Service and confirm publication.
        </li>
        <li>
          <strong>5.2</strong> Where the Service offers an option to approve multiple suggestions at
          once, that option applies only to Pins presented to you in that session. The number of Pins
          affected will be shown to you before any change is made. Approving in bulk is still your
          instruction, and you are responsible for the result.
        </li>
        <li>
          <strong>5.3</strong> We do not schedule Pins, post on your behalf on a timer, re-pin
          third-party content, or run any background process that modifies your Pinterest account.
        </li>
        <li>
          <strong>5.4</strong> Changes made to your Pins are made on Pinterest and persist there. If
          you disconnect ShopMyPin, previously updated Pins keep their current destination links
          until you change them yourself.
        </li>
      </ul>

      <h2 className="mt-10 font-display text-xl font-bold">
        6. Product matching is automated and imperfect
      </h2>
      <ul className="mt-4 list-disc space-y-3 pl-6">
        <li>
          <strong>6.1</strong> Product suggestions are generated automatically by analysing your Pin
          images and text. They are suggestions, not verified matches.
        </li>
        <li>
          <strong>6.2</strong> A suggestion may be wrong &mdash; a different product, a different
          brand, a different colour, or an item that is out of stock, priced differently, or no
          longer sold.
        </li>
        <li>
          <strong>6.3</strong> You must review each suggestion before approving it. By approving, you
          accept responsibility for the accuracy and appropriateness of the link attached to your
          Pin.
        </li>
        <li>
          <strong>6.4</strong> We do not warrant the availability, price, quality, legality, or
          description of any retailer product surfaced through the Service. Purchases are contracts
          between the shopper and the retailer. We are not a party to them.
        </li>
      </ul>

      <h2 className="mt-10 font-display text-xl font-bold">7. Earnings, tracking and payouts</h2>
      <ul className="mt-4 list-disc space-y-3 pl-6">
        <li>
          <strong>7.1</strong> Affiliate commission is earned only where a purchase is validly
          tracked and attributed by the retailer or affiliate network and confirmed to us.
        </li>
        <li>
          <strong>7.2</strong> Commission rates are set by retailers and networks, change without
          notice, and are outside our control.
        </li>
        <li>
          <strong>7.3</strong> A retailer or network may cancel, reverse or reduce commission &mdash;
          for reasons including returns, cancellations, non-delivery, self-purchase, bulk buying,
          untracked or misattributed sales, coupon misuse, or breach of that retailer&rsquo;s
          affiliate policy. Where commission is cancelled upstream, we are not liable to pay it, and
          we may reverse it from your wallet.
        </li>
        <li>
          <strong>7.4</strong> Payouts are subject to EarnKaro&rsquo;s minimum threshold,
          verification requirements, and payout schedule. You must supply accurate bank details and
          PAN. Tax deducted at source will be applied where required by Indian law, and you are
          responsible for your own tax obligations on earnings.
        </li>
        <li>
          <strong>7.5</strong> We may withhold or reverse earnings where we reasonably suspect fraud,
          self-referral, incentivised clicks, artificially generated traffic, or breach of these
          Terms, pending investigation.
        </li>
      </ul>

      <h2 className="mt-10 font-display text-xl font-bold">
        8. Your content and the licence you give us
      </h2>
      <ul className="mt-4 list-disc space-y-3 pl-6">
        <li>
          <strong>8.1</strong> You retain all rights in your Pins, images and content. We claim no
          ownership.
        </li>
        <li>
          <strong>8.2</strong> You grant us a limited, non-exclusive, royalty-free, worldwide,
          revocable licence to access, cache the metadata of, display and process your Pin content
          solely to provide the Service to you &mdash; that is, to show your Pins back to you in the
          product, run product matching, and render your public store page.
        </li>
        <li>
          <strong>8.3</strong> This licence ends when you disconnect Pinterest or delete your
          account, subject to the retention periods in the Privacy Policy.
        </li>
        <li>
          <strong>8.4</strong> We do not use your Pin content for our own marketing, do not licence
          it to third parties, and do not use it to train general-purpose machine learning models.
        </li>
        <li>
          <strong>8.5</strong> Your public store page is public. Anything you choose to publish there
          &mdash; collection names, descriptions, product selections &mdash; is visible to anyone
          with the link and may be indexed by search engines.
        </li>
      </ul>

      <h2 className="mt-10 font-display text-xl font-bold">9. Acceptable use</h2>
      <p className="mt-4">You must not:</p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>Connect a Pinterest account you do not own or control.</li>
        <li>
          Use the Service to create spam, misleading, deceptive, or low-quality Pins, or to Pin
          content you do not have the rights to.
        </li>
        <li>
          Attach a destination link that is materially unrelated to the Pin&rsquo;s content, or
          cloak, redirect or mask a link to disguise its destination.
        </li>
        <li>
          Attempt to generate artificial clicks, orders or commission, including by self-purchase,
          incentivised clicks, bots, or click farms.
        </li>
        <li>
          Circumvent, disable or interfere with the review and approval steps in the Service.
        </li>
        <li>
          Reverse engineer, decompile, scrape, or attempt to extract source code or data from the
          Service, or access it by automated means other than as we expressly permit.
        </li>
        <li>Resell, sublicence, or provide the Service to third parties as your own.</li>
        <li>
          Use the Service to promote content prohibited by Pinterest, by applicable law, or by any
          retailer&rsquo;s affiliate policy &mdash; including adult content, weapons, tobacco,
          illegal goods, counterfeit products, or misleading health and financial claims.
        </li>
        <li>
          Interfere with the security or integrity of the Service, or attempt to gain unauthorised
          access to any account or system.
        </li>
      </ul>
      <p className="mt-4">
        Breach of this section may result in immediate suspension, forfeiture of unpaid earnings
        where the breach relates to those earnings, and reporting to Pinterest, retailers, or
        authorities where appropriate.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">10. Suspension and termination</h2>
      <ul className="mt-4 list-disc space-y-3 pl-6">
        <li>
          <strong>10.1</strong> You may stop using the Service at any time, disconnect Pinterest, and
          request account deletion.
        </li>
        <li>
          <strong>10.2</strong> We may suspend or terminate your access, with notice where
          practicable and immediately where not, if you breach these Terms, if we reasonably suspect
          fraud or abuse, if required by law or by Pinterest, or if we discontinue the Service.
        </li>
        <li>
          <strong>10.3</strong> On termination, your licence to use the Service ends. Sections 7 (in
          respect of earnings already accrued and reversals), 8.1, 11, 12, 13, 14 and 16 survive.
        </li>
        <li>
          <strong>10.4</strong> If we discontinue the Service entirely, we will give reasonable
          notice and process legitimately earned, confirmed commission in the ordinary course.
        </li>
      </ul>

      <h2 className="mt-10 font-display text-xl font-bold">11. Disclaimers</h2>
      <ul className="mt-4 list-disc space-y-3 pl-6">
        <li>
          <strong>11.1</strong> The Service is provided &ldquo;as is&rdquo; and &ldquo;as
          available&rdquo;, without warranties of any kind, express or implied, including any implied
          warranty of merchantability, fitness for a particular purpose, accuracy, or
          non-infringement.
        </li>
        <li>
          <strong>11.2</strong> We do not warrant that the Service will be uninterrupted, error-free,
          or secure, that product matches will be accurate, that any particular level of earnings
          will be achieved, or that Pinterest will continue to make its API available to us.
        </li>
        <li>
          <strong>11.3</strong> We are not responsible for the acts or omissions of Pinterest,
          retailers, affiliate networks, or payment providers.
        </li>
        <li>
          <strong>11.4</strong> Nothing in the Service constitutes financial, tax, or legal advice.
        </li>
      </ul>

      <h2 className="mt-10 font-display text-xl font-bold">12. Limitation of liability</h2>
      <p className="mt-4">To the maximum extent permitted by law:</p>
      <ul className="mt-4 list-disc space-y-3 pl-6">
        <li>
          <strong>12.1</strong> We will not be liable for any indirect, incidental, special,
          consequential, exemplary or punitive damages, or for loss of profits, revenue, goodwill,
          data, or business opportunity, however caused.
        </li>
        <li>
          <strong>12.2</strong> Our total aggregate liability to you for all claims arising out of or
          relating to the Service in any twelve-month period is limited to the total confirmed
          commission actually paid to you through the Service in that period, or INR 5,000, whichever
          is higher.
        </li>
        <li>
          <strong>12.3</strong> Nothing in these Terms excludes liability that cannot lawfully be
          excluded, including liability for fraud or for death or personal injury caused by
          negligence.
        </li>
      </ul>

      <h2 className="mt-10 font-display text-xl font-bold">13. Indemnity</h2>
      <p className="mt-4">
        You agree to indemnify and hold harmless Pouring Pounds India Private Limited, its directors,
        officers, employees and agents from any claim, demand, loss, liability, or expense (including
        reasonable legal fees) arising from: your use of the Service; your Pins and the content in
        them; your breach of these Terms, of Pinterest&rsquo;s rules, or of any retailer&rsquo;s
        affiliate policy; your failure to make required affiliate disclosures; or your infringement
        of any third party&rsquo;s rights.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">14. Intellectual property</h2>
      <p className="mt-4">
        The Service, including its software, design, interface, text and branding, is owned by
        Pouring Pounds India Private Limited and protected by intellectual property law. We grant you
        a personal, non-exclusive, non-transferable, revocable licence to use the Service in
        accordance with these Terms. No other rights are granted. You may not use our name, logo, or
        branding without our written permission.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">15. Changes to these Terms</h2>
      <p className="mt-4">
        We may update these Terms. The revised version will be posted here with a new &ldquo;Last
        updated&rdquo; date. Where a change is material, we will notify you by email or in-product
        before it takes effect. Continuing to use the Service after a change takes effect means you
        accept it. If you do not accept it, stop using the Service and disconnect Pinterest.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">
        16. Governing law, disputes and grievances
      </h2>
      <ul className="mt-4 list-disc space-y-3 pl-6">
        <li>
          <strong>16.1</strong> These Terms are governed by the laws of India.
        </li>
        <li>
          <strong>16.2</strong> The courts at Gurgaon, Haryana have exclusive jurisdiction, subject
          to Section 16.3.
        </li>
        <li>
          <strong>16.3</strong> Before commencing proceedings, both parties will attempt in good
          faith to resolve the dispute through the grievance process below for at least 30 days.
        </li>
        <li>
          <strong>16.4</strong> Grievance Officer (appointed under the Information Technology
          (Intermediary Guidelines and Digital Media Ethics Code) Rules, 2021):
        </li>
      </ul>
      <p className="mt-4">
        Manish Saini, IT Manager
        <br />
        Pouring Pounds India Private Limited
        <br />
        UM House, 2nd Floor, Sector 44, Gurgaon, Haryana 122002, India
        <br />
        support@earnkaro.com
      </p>
      <p className="mt-4">
        We acknowledge complaints within 24 hours and aim to resolve them within 15 days.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">17. General</h2>
      <ul className="mt-4 list-disc space-y-3 pl-6">
        <li>
          <strong>Entire agreement.</strong> These Terms, together with the Privacy Policy and
          &mdash; for affiliate and payout matters &mdash; EarnKaro&rsquo;s Terms and Conditions,
          form the entire agreement between you and us regarding the Service.
        </li>
        <li>
          <strong>Severability.</strong> If any provision is held unenforceable, the remainder
          continues in full force.
        </li>
        <li>
          <strong>No waiver.</strong> Our failure to enforce a provision is not a waiver of it.
        </li>
        <li>
          <strong>Assignment.</strong> You may not assign these Terms. We may assign them to an
          affiliate or in connection with a merger, acquisition, or sale of assets.
        </li>
        <li>
          <strong>Force majeure.</strong> We are not liable for failure or delay caused by events
          beyond our reasonable control, including changes to or withdrawal of the Pinterest API.
        </li>
        <li>
          <strong>Contact.</strong> support@earnkaro.com
        </li>
      </ul>
    </div>
  );
}
