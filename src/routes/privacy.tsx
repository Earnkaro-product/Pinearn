import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";

export const Route = createFileRoute("/privacy")({
  head: () => ({
    meta: [{ title: "Privacy Policy — ShopMyPin" }],
  }),
  component: PrivacyPolicy,
});

function PrivacyPolicy() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-10 text-sm leading-relaxed text-foreground">
      <Link
        to="/"
        className="mb-8 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" /> Back
      </Link>

      <h1 className="font-display text-3xl font-bold">Privacy Policy</h1>

      <p className="mt-6">
        Pouring Pounds Limited and/ or Pouring Pounds India Private Limited (as the case may be) (
        We&rdquo;, &ldquo;Our&rdquo;, &ldquo;EarnKaro&rdquo; or &ldquo;Us&rdquo;, where such
        expression shall unless repugnant to the context thereof, be deemed to include its
        respective legal heirs, representatives, administrators, permitted successors and assigns)
        own and/ or operate the website and mobile application EarnKaro.com (&ldquo;Website&rdquo;,
        &ldquo;Our Website&rdquo;, &ldquo;Site&rdquo;).
      </p>

      <p className="mt-4">
        For the purpose of providing the Services (as defined in clause 1 below), EarnKaro is
        required to collect and use certain information of the users of the Website
        (&ldquo;Users&rdquo;) using the Services and involves capturing, storage and transmission of
        such information. This privacy policy (&quot;Privacy Policy&quot;/ &ldquo;Policy&rdquo;)
        explains how We collect, use, share and protect personal information of the Users of the
        Services (jointly and severally referred to as &ldquo;You&rdquo;, &ldquo;Your&rdquo;,
        &ldquo;Yourself&rdquo; or &ldquo;User&rdquo; or &ldquo;Users&rdquo; in this Privacy Policy).
        We have created this Privacy Policy to ensure our steady commitment to the privacy of the
        information of the Users who interact with our Services. Your use of and access to the
        Services is subject to this Privacy Policy and our Terms and Conditions. Any capitalized
        term used, but not defined, in this Privacy Policy shall have the meaning attributed to it
        in our Terms and Conditions.
      </p>

      <p className="mt-4">
        The headings used herein are only for the purpose of arranging the various provisions of the
        Privacy Policy. The headings are for the purpose of reference only and shall not be
        interpreted to limit or expand the provisions of the clauses contained therein.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">1. Definitions</h2>
      <p className="mt-4">
        In this Privacy Policy, unless the context otherwise requires, the terms defined shall bear
        the meanings assigned to them below, and their cognate expressions shall be construed
        accordingly.
      </p>
      <p className="mt-4">
        &ldquo;Personal Information&rdquo; shall have the same meaning as given in Rule 2(1)(i) of
        the Information Technology (Reasonable Security Practices and Procedures and Sensitive
        Personal Data or Information) Rules, 2011 to mean any information that relates to a natural
        person, which, either directly or indirectly, in combination with other information
        available or likely to be available to a body corporate, is capable of identifying such
        person.
      </p>
      <p className="mt-4">
        The SPI Rules further define &ldquo;Sensitive Personal Data or Information&rdquo; of a
        person to mean Personal Information about that person relating to:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>passwords;</li>
        <li>
          financial information such as bank accounts, credit and debit card details or other
          payment instrument details;
        </li>
        <li>physical, physiological and mental health condition;</li>
        <li>sexual orientation;</li>
        <li>medical records and history;</li>
        <li>biometric information;</li>
        <li>information received by body corporate under lawful contract or otherwise;</li>
        <li>visitor details as provided at the time of registration or thereafter; and</li>
        <li>call data records.</li>
      </ul>
      <p className="mt-4">
        &ldquo;You&rdquo;, &ldquo;Your&rdquo;, &ldquo;Yourself&rdquo; and &ldquo;User&rdquo; shall
        mean and refer to natural &amp; legal individuals and legal entities/companies who visit
        and/or use the Services and will also include the individuals/entities/companies who avail
        the services by submission of details by some other person.
      </p>
      <p className="mt-4">
        &ldquo;Third Parties&rdquo; refer to any website/application/web portal, company or
        individual apart from the User and Us.
      </p>
      <p className="mt-4">
        &ldquo;Services&rdquo; shall mean the Website (https://earnkaro.com/) and Mobile Application
        (EarnKaro) and contextual information transmitted to/ received from Users via various
        communication channels including but not limited to e-mail, SMS, WhatsApp, phone calls,
        website chat, IVR. We are primarily engaged in the business of allowing Users to share
        customized links for various products in the network of such Users, the customized links
        drive sales to e-commerce websites and in turn the Users earn cashbacks. We currently
        operate under the brand name EarnKaro.
      </p>
      <p className="mt-4">
        &ldquo;User Information&rdquo; shall mean Personal Information and Sensitive Personal Data
        or Information.
      </p>
      <p className="mt-4">
        &ldquo;Website&rdquo; shall mean and refer to https://earnkaro.com/, the
        &ldquo;Application&rdquo; and/ or &ldquo;App&rdquo; shall refer to the EarnKaro mobile
        application available on Android Play Store or iOS App Store. These shall be collectively
        referred to as the &ldquo;Platform&rdquo;
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">2. WHY THIS PRIVACY POLICY?</h2>
      <p className="mt-4">This Privacy Policy is published in compliance with, inter alia,</p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>Section 43A of the Information Technology Act, 2000;</li>
        <li>Regulation 4 of the SPI Rules; and</li>
        <li>
          Regulation 3(1) of the Information Technology (Intermediaries Guidelines) Rules, 2011
          (&ldquo;Intermediaries Guidelines&rdquo;).
        </li>
      </ul>
      <p className="mt-4">This Privacy Policy states, inter alia, the following:</p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>
          The type of information collected from the Users, including Sensitive Personal Data or
          Information;
        </li>
        <li>The purpose, means and modes of usage of such information; and</li>
        <li>How and to whom we will disclose such information</li>
      </ul>

      <h2 className="mt-10 font-display text-xl font-bold">3. GENERAL</h2>
      <ul className="mt-4 list-disc space-y-3 pl-6">
        <li>
          The User unequivocally agrees that this Policy and the aforementioned Terms and Conditions
          constitute a legally binding agreement between the User and EarnKaro, and that the User
          shall be subject to the rules, guidelines, policies, terms, and conditions applicable to
          any service that is provided by EarnKaro including the Services, and that the same shall
          be deemed to be incorporated into the Terms and Conditions, and shall be treated as part
          of the same.
        </li>
        <li>
          This document is an electronic record in terms of Information Technology Act, 2000 and
          rules there under as applicable and the amended provisions pertaining to electronic
          records in various statutes as amended by the Information Technology Act, 2000. This
          electronic record is generated by a computer system and does not require any physical or
          digital signatures. Further, this document is published in accordance with the provisions
          of the SPI Rules and Intermediaries Guidelines.
        </li>
        <li>
          The terms &lsquo;Party&rsquo; and &lsquo;Parties&rsquo; shall respectively be used to
          refer to the User and EarnKaro individually and collectively, as the context so requires.
        </li>
        <li>
          The headings of each section in this Policy are only for the purpose of organizing the
          various provisions under this Policy in an orderly manner and shall not be used by either
          Party to interpret the provisions contained herein in any manner. Further, it is
          specifically agreed to by the Parties that the headings shall have no legal or contractual
          value.
        </li>
        <li>
          The Parties expressly agree that subject to clause 13 of this Policy, EarnKaro retains the
          sole and exclusive right to amend or modify the Policy and the aforementioned Terms and
          Conditions without any prior permission or intimation to the User keeping in mind best
          practices and laws set by State/Central Government of India, and the User expressly agrees
          that any such amendments or modifications shall come into effect immediately. The User has
          a duty to periodically check the Policy and Terms and Conditions and stay updated on their
          provisions and requirements. If the User continues to use the Services following such a
          change, the User will be deemed to have consented to any and all amendments/ modifications
          made to the Policy and Terms and Conditions. In so far as the User complies with the
          Policy and Terms and Conditions, he/she is granted a personal, non-exclusive,
          non-transferable, revocable, limited privilege to enter, access and use the Services.
        </li>
      </ul>

      <h2 className="mt-10 font-display text-xl font-bold">
        4. COLLECTION AND HANDLING OF PERSONAL INFORMATION
      </h2>
      <p className="mt-4">
        Privacy of the Parties is of prime importance to Us and all Services are strictly designed
        within the jurisdiction of laws defined by the Government of India.
      </p>
      <p className="mt-4">
        Generally, the Services require us to know who you are so that we can best meet your needs.
        When you access the Services, we may ask you to voluntarily provide us with certain
        information that personally identifies you or could be used to personally identify you.
        Without prejudice to the generality of the above, information collected by us from you may
        include (but is not limited to) the following:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>Contact data (such as your email address and phone number);</li>
        <li>User name and passwords;</li>
        <li>
          Demographic data (such as your name, gender, age, your date of birth and your pin code);
        </li>
        <li>
          Data regarding your usage of the services and other transactions made by or with you
          through the use of Services;
        </li>
        <li>
          Information about your clicks on and from EarnKaro mobile device, web browser, web and
          mobile browsing patterns, retailer preferences
        </li>
        <li>
          Your bank account information including name of the bank account, account number, IFSC
          code, bank branch or any other payment related information
        </li>
        <li>
          Any other information that you voluntarily choose to provide to us (such as information
          shared by you with us through emails, calls or letters, your work details, home / work
          address, your family details, details about transactions done on ecommerce sites,
          screenshots of transactions, order IDs for transactions, alternate numbers and emails and
          various other information provided from time to time).
        </li>
      </ul>
      <p className="mt-4">
        The information collected from You by Us shall constitute &lsquo;Personal Information&rsquo;
        or &lsquo;Sensitive Personal Data Information&rsquo; under the SPI Rules.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">5. PRIVACY STATEMENTS</h2>
      <p className="mt-4">5.1. The User expressly agrees and acknowledges:</p>
      <ul className="mt-4 list-disc space-y-3 pl-6">
        <li>
          Information that is freely available in the public domain or accessible under the Right to
          Information Act, 2005 or any other law will not be considered as &lsquo;Personal
          Information&rsquo; or &lsquo;Sensitive Personal Data or Information&rsquo; for the
          purposes of this Policy.That EarnKaro may automatically track information about the User
          based on the User&rsquo;s IP address and the User&rsquo;s behaviour on the Platform, and
          the User expressly consents to the same. The User is aware that this information may be
          used to conduct internal research on user demographics, interests, and behaviour, to
          enable EarnKaro to better understand, and cater to the interests of the Users. Further,
          the User is expressly made aware that such information may include the User&rsquo;s
          computer &amp; web browser information, the User&rsquo;s IP address, mobile device details
          etc. The linkage between User&rsquo;s IP address and User&rsquo;s personally identifiable
          information may be shared with or disclosed to third parties in order to facilitate the
          provisions of the Services to You. The User hereby consents to the sharing of such
          information to such third parties as may be determined by EarnKaro from time to time.
          Further, we may also share and/or disclose some of the aggregate findings (not the
          specific data) in anonymized form (i.e., non-personally identifiable) with third parties
          for market research and new feature development.
        </li>
        <li>
          That any and all information pertaining to the User collected by EarnKaro, whether or not
          directly provided by the User to EarnKaro, including but not limited to personal
          correspondence such as emails or letters or SMS or WhatsApp or calls, feedback from other
          users or third parties regarding the User&rsquo;s activities or postings on the Platform,
          etc., may be collected and compiled by EarnKaro into a file/folder specifically created
          for/allotted to the User, and the User hereby expressly consents to the same.Also, in
          order to keep You informed of Your activities on the Website we occasionally send You
          emails, SMS, App notifications and other marketing communication. These include Your
          transaction messages to show how much You have earned, referral messages that show You how
          much You have earned from referrals, payment confirmations for payments to You and,
          important administrative messages and messages to confirm Your activities on the Website.
          These emails are not shared with anyone else apart from You.We also send newsletters,
          SMSs, App notifications, browser notification and other marketing that features some of
          our best ideas to help You save more. You may choose not to receive this marketing
          communication from EarnKaro by informing Us at any time.We do not support spamming by our
          members and we explicitly prohibit it in our Terms and Conditions. If You would like to
          report an incident of spamming, please contact us so we can investigate and take suitable
          action.
        </li>
        <li>
          That the contact information provided to EarnKaro may be used to send the User offers and
          promotions, whether or not based on the User&rsquo;s previous interests, and the User
          hereby expressly consents to receiving the same. The User may choose to unsubscribe from
          promotional communications by clicking on the &lsquo;unsubscribe&rsquo; link provided at
          the end of such promotional communication or by emailing us on support@earnkaro.com
        </li>
        <li>
          That EarnKaro may occasionally request the User to complete optional online surveys. These
          surveys may require the User to provide contact information and demographic information
          (like zip code, age, income bracket, sex, etc.). The User is aware that this information
          is used to improve/customise the Services for the benefit of the User and providing all
          users of the Platform with services that EarnKaro believes they might be interested in
          availing of.
        </li>
        <li>
          That EarnKaro may keep records of electronic communications and telephone calls received
          and made for support or other purposes for the purpose of administration of Services,
          customer support, research and development and for better assistance to Users.That
          EarnKaro may occasionally request the User to write reviews for services availed of by the
          User from the Platform. The User is aware that such reviews will help potential users of
          the Platform in availing the Services, and the User hereby expressly authorizes EarnKaro
          to publish any and all reviews written by the User on the Platform, along with the
          User&rsquo;s name and certain contact details, for the benefit and use of other users.
        </li>
        <li>
          Nothing contained herein shall be deemed to compel EarnKaro to store, upload, publish, or
          display in any manner content/reviews/surveys/feedback submitted by the User, and the User
          hereby expressly authorizes EarnKaro to remove from the Platform any such content, review,
          survey, or feedback submitted by the User, without cause or being required to notify the
          User of the same.
        </li>
        <li>
          Generation and collection of &lsquo;Sensitive Personal Data or Information&rsquo; in
          accordance with Information Technology Act, 2000 as amended from time to time and allied
          rules requires the User&rsquo;s express consent. By affirming assent to this Policy as
          well as clicking on the &ldquo;I agree with Terms and Policy&rdquo; button at the time of
          registration, the User provides consent to such generation and collection as required
          under applicable laws.
        </li>
        <li>
          The User is responsible for ensuring that the accuracy of the information submitted to
          EarnKaro. The User may correct, delete inaccuracies, or amend information by contacting
          EarnKaro through email on support@earnkaro.com. EarnKaro will make good faith efforts to
          make requested changes in the databases as soon as reasonably practicable. If the User
          provides any information that is untrue, inaccurate, out of date or incomplete (or becomes
          untrue, inaccurate, out of date or incomplete), or EarnKaro has reasonable grounds to
          suspect that the information provided by the User is untrue, inaccurate, out of date or
          incomplete, EarnKaro may, at its sole discretion, discontinue the provision of the
          Services to you as per the provisions laid down in the Terms and Conditions. There may be
          circumstances where Pouring Pounds will not correct, delete or update your Personal Data,
          including (a) where the Personal Data is opinion data that is kept solely for evaluative
          purpose; and (b) the Personal Data is in documents related to a prosecution if all
          proceedings relating to the prosecution have not been completed.
        </li>
        <li>
          All the information provided to Us by a User, including Sensitive Personal Data or
          Information, is voluntary. User has the right to withdraw his/ her/ its consent at any
          time, in accordance with the terms of this Privacy Policy, and the Terms and Conditions
          applicable to such User, it being however clarified that withdrawal of consent will not be
          retroactive. If the User wishes to delete his/her account or request that EarnKaro no
          longer uses the User&rsquo;s information to provide Services, the User may contact
          EarnKaro on support@earnkaro.com. We shall not retain such information for longer than is
          required for the purposes for which the information may lawfully be used or is otherwise
          required under any other law for the time being in force. After a period of time, your
          data may be anonymized and aggregated, and then may be held by us as long as necessary for
          us to provide our Services effectively, but our use of the anonymized data will be solely
          for analytic purposes. Please note that your withdrawal of consent, or cancellation of
          account may result in Pouring Pounds being unable to provide you with its Services or to
          terminate any existing relationship Pouring Pounds may have with you.
        </li>
        <li>
          If you wish to opt-out of receiving non-essential communications such as promotional and
          marketing-related information regarding the Services, please send us an email at
          support@earnkaro.com.
        </li>
      </ul>

      <h2 className="mt-10 font-display text-xl font-bold">6. OUR USE OF YOUR INFORMATION</h2>
      <p className="mt-4">
        All the information provided to EarnKaro by a User, including Personal Information or any
        Sensitive Personal Data or Information, is voluntary. Such information in its original form
        may be shared with any Third Parties in furtherance of the consent from the User as provided
        hereunder. You understand that EarnKaro may use certain information of yours, which has been
        designated as Personal Information or &lsquo;Sensitive Personal Data or Information&rsquo;
        under the SPI Rules for the following purposes:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>providing you the Services;</li>
        <li>taking product &amp; Services feedback;</li>
        <li>for offering new products or services and marketing of the Services;</li>
        <li>for analysing software usage patterns for improving product design and utility;</li>
        <li>
          for providing the services of generating alerts/reminders/SMS for offers and also for
          internal record.
        </li>
        <li>
          for commercial purposes and in an aggregated or non-personally identifiable form for
          research, statistical analysis and business intelligence purposes,
        </li>
        <li>
          for sale or transfer of such research, statistical or intelligence data in a
          non-personally identifiable form to third parties and affiliates;
        </li>
        <li>debugging customer support related issues; and</li>
      </ul>
      <p className="mt-4">
        We may use your tracking information such as IP addresses, and or Device ID to help identify
        You and to gather broad demographic information.
      </p>
      <p className="mt-4">
        In case we are acquired by or merged with another company, We shall transfer information
        disclosed by You and information about You to the company we are acquired by or merged with,
        and such company will have the right to continue to use the User&rsquo;s Personal
        Information and/ or other information that a User provides to Us. In the event of a merger
        or acquisition, We shall notify You by email/by putting a notice on the Website and/ or
        Application before Your Personal Information is transferred and becomes subject to a
        different privacy policy.
      </p>
      <p className="mt-4">
        The Users expressly agree and acknowledge that EarnKaro collects and stores the User&rsquo;s
        Personal Information and/or Sensitive Personal Information in a secure cloud based platform
        which is provided by the User from time to time on the Platform or while using other
        Services.
      </p>
      <p className="mt-4">
        The User is aware that this information will be used by EarnKaro to deliver its services and
        help customize/improve the Platform experience safer and easier but no personally
        identifiable information will be shared with any Third Party under any circumstances without
        User&rsquo;s explicit consent unless directed by the law.
      </p>
      <p className="mt-4">
        EarnKaro may need to disclose/ transfer User&rsquo;s Personal Information to the following
        third parties for the purposes mentioned in this Privacy Policy, and the Terms and
        Conditions as applicable to such User:
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>
          To government institutions/ authorities to the extent required:
          <ul className="mt-1 list-disc space-y-1 pl-6">
            <li>
              under the laws, rules, and regulations and/ or under orders of any relevant judicial
              or quasi-judicial authority;
            </li>
            <li>to protect and defend the rights or property of EarnKaro;</li>
            <li>to fight fraud and credit risk;</li>
            <li>to enforce EarnKaro&rsquo;s Terms and Conditions applicable to the Users; or</li>
            <li>
              when EarnKaro, in its sole discretion, deems it necessary in order to protect its
              rights or the rights of others.
            </li>
          </ul>
        </li>
        <li>
          If otherwise required by an order under any law for the time being in force including in
          response to enquiries by government agencies for the purpose of verification of identity,
          or for prevention, detection, investigation including cyber incidents, prosecution, and
          punishment of offences.
        </li>
      </ul>
      <p className="mt-4">
        However, We contract with third parties to serve ads on our behalf across the Internet and
        sometimes on this site. They may collect information about Your visits to our website, and
        Your interaction with our products and services. They may also use information about Your
        visits to this and other websites to target advertisements for goods and services. This
        information is collected through the use of a pixel tag, which is industry standard
        technology used by most major websites. Such third parties are not permitted to sell or
        share Your personally identifiable information as part of this process.
      </p>
      <p className="mt-4">
        The following third-party vendors, including Google, Facebook, advertising platforms,
        remarketing platforms like CleverTap, customer query management platforms like Freshworks
        &amp; Exotel use cookies to serve ads based on a user&apos;s prior visits to Your website.
      </p>
      <p className="mt-4">
        Google&apos;s use of the DoubleClick cookie enables it and its partners to serve ads to your
        users based on their visit to your sites and/or other sites on the Internet.
      </p>
      <p className="mt-4">
        Users may opt out of the use of the DoubleClick cookie for interest-based advertising by
        visiting Ads Settings.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">7. CONFIDENTIALITY AND SECURITY</h2>
      <p className="mt-4">
        7.1. Your information is regarded as confidential and therefore shall not be divulged to any
        Third Parties, unless as provided hereunder and unless legally required to do so to the
        appropriate authorities, or if necessary, for providing the Services through the Platform.
      </p>
      <p className="mt-4">
        7.2. Your Personal Information/Sensitive Personal Data is maintained by Us in an electronic
        form on our equipments, and on the equipments of our employees. Such information may also be
        converted to physical form from time to time.
      </p>
      <p className="mt-4">7.3. People who can access your Personal Information</p>
      <p className="mt-2">
        User Information will be processed by our employees, authorised staff, marketing agencies or
        agents, on a need to know basis, depending on the specific purposes for which the User
        Information have been collected by Us. EarnKaro may, therefore, retain and submit all such
        records to the relevant stakeholders.
      </p>
      <p className="mt-4">
        7.4. Security Practices. We treat data as an asset that must be protected against loss and
        unauthorised access. We employ many different security techniques to protect such data from
        unauthorized access by members inside and outside EarnKaro. We follow generally accepted
        industry standards to protect the User Information submitted to Us and information that We
        have accessed, including managerial, technical, operational and physical security control
        measures. However, for any data loss or theft due to unauthorized access to the User&rsquo;s
        electronic devices through which the User avails the Services, We shall not be held liable
        for any loss whatsoever incurred by the User.
      </p>
      <p className="mt-4">
        7.5. Measures We expect you to take: It is important that you also play a role in keeping
        your User Information safe and secure. When signing up for an online account, please be sure
        to choose an account password that would be difficult for others to guess and never reveal
        your password to anyone else. You are responsible for keeping this password confidential and
        for any use of your account. If you use a shared or public computer, never choose to have
        your login ID/email address or password remembered and make sure to log out of your account
        every time you leave the computer. You should also make use of any privacy settings or
        controls We provide you in Our Platform.
      </p>
      <p className="mt-4">
        7.6. Unauthorised use of User&rsquo;s account. We do not undertake any liability for any
        unauthorized use of your account and password. If you suspect any unauthorized use of your
        account, you must immediately notify Us by sending an email to support@earnkaro.com.
      </p>
      <p className="mt-4">
        7.7. Notwithstanding the above, EarnKaro is not responsible for the confidentiality,
        security or distribution of your Personal Information by third parties outside the scope of
        our agreement with such third parties. Further, EarnKaro shall not be responsible for any
        breach of security or for any actions of any third parties or events that are beyond the
        reasonable control of EarnKaro including but not limited to the, acts of government,
        computer hacking, unauthorised access to computer data and storage device, computer crashes,
        breach of security and encryption.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">8. RETENTION OF YOUR PERSONAL DATA</h2>
      <p className="mt-4">
        In accordance with applicable laws, We will use the User Information for as long as
        necessary to satisfy the purposes for which such User Information was collected (as
        described in Section 4 above) or to comply with applicable legal requirements.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">9. YOUR RIGHTS</h2>
      <p className="mt-4">
        9.1. Access to Personal Data. You have the right to access, review and request a physical or
        electronic copy of information held about you. You also have the right to request
        information on the source of your Personal Information/Sensitive Personal Information.
      </p>
      <p className="mt-4">
        9.2. Additional rights (e.g. modification, deletion of Personal Data). Where provided by
        law, you can (i) request deletion, the portability, correction or revision of your User
        Information; (ii) limit the use and disclosure of your Personal Data; and (iii) revoke
        consent to any of our data processing activities. Provided that, we may be required to
        retain some of your User Information after you have requested deletion, to satisfy our legal
        or contractual obligations. We may also be permitted by applicable laws to retain some of
        your User Information to satisfy our business needs.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">
        10. CHILDREN&rsquo;S AND MINOR&rsquo;S PRIVACY
      </h2>
      <p className="mt-4">
        We strongly encourage parents and guardians to supervise the online activities of their
        minor children and consider using parental control tools available from online services and
        software manufacturers to help provide a child-friendly online environment. These tools can
        also prevent minors from disclosing their name, address, and other personally identifiable
        information online without parental permission. Although the Services are not intended for
        use by minors, We respect the privacy of minors who may inadvertently use the internet or
        the mobile application.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">11. CONSENT TO THIS POLICY</h2>
      <p className="mt-4">
        You acknowledge that this Privacy Policy is a part of the Terms and Conditions of the
        Website and the other Services, and you acknowledge that you have unconditionally agreed as
        User of the Platform and the Services signifies your assent to this Privacy Policy. Your
        visit to the Website, use of the App and use of the Services is subject to this Privacy
        Policy and the Terms and Conditions.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">12. COOKIES</h2>
      <p className="mt-4">
        When You avail our Services on the Platform, a persistent cookie is placed on Your computer.
      </p>
      <p className="mt-4">
        This enables us to track any purchases You make with our participating retailers and award
        cashback / rewards / points to You. If You do not have such persistent cookies enabled on
        Your computer You will not be able to earn cashback / points on Your online shopping via Our
        Platform.
      </p>
      <p className="mt-4">
        Disabling/enabling cookies: You have the ability to accept or decline cookies by modifying
        the settings in Your browser. However, You may not be able to use all the interactive
        features of Our Platform if cookies are disabled.
      </p>
      <p className="mt-4">
        Please note: if You disable the cookies in Your browser which are used to track Your
        purchases via Our Platform, You will not be able to earn cashback / point when You shop from
        our website.
      </p>
      <p className="mt-4">
        There are a number of ways to manage cookies. If You use different computers in different
        locations You will need to ensure that each browser is adjusted to suit Your cookie
        preferences.
      </p>
      <p className="mt-4">
        You can easily delete any cookies that have been installed in the cookie folder of your
        browser. For example, if you are using Microsoft Windows Explorer:
      </p>
      <ol className="mt-2 list-decimal space-y-1 pl-6">
        <li>Open &apos;Windows Explorer&apos;</li>
        <li>Click on the &apos;Search&apos; button on the tool bar</li>
        <li>Type &quot;cookie&quot; into the search box for &apos;Folders and Files&apos;</li>
        <li>Select &apos;My Computer&apos; in the &apos;Look In&apos; box</li>
        <li>Click &apos;Search Now&apos;</li>
        <li>Double click on the folders that are found</li>
        <li>&apos;Select&apos; any cookie file</li>
        <li>Hit the &apos;Delete&apos; button on your keyboard</li>
      </ol>
      <p className="mt-4">
        If you are not using Microsoft Windows Explorer, then you should select &quot;cookies&quot;
        in the &quot;Help&quot; function for information on where to find your cookie folder
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">13. AFFILIATE COMMISSION</h2>
      <p className="mt-4">
        EarnKaro, an affiliate platform, is essentially a service provider that connects retailers
        and publishers. EarnKaro is not liable to pay for any commission which is cancelled by the
        partner retailer due to any reason whatsoever and not limited to bulk buying, self
        consumption, unattributed sale, return or cancellation of product and/or violating any
        affiliate policy of our partner retailer. Users are required to constantly keep a check on
        profit rates and terms of campaigns as these are subject to change real time without prior
        notice. EarnKaro reserves the right to cancel the profit as directed by the partner
        retailer. By signing up on EarnKaro, user agrees to abide by this clause.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">
        14. AMENDMENTS OR CHANGE TO PRIVACY POLICY
      </h2>
      <p className="mt-4">
        EarnKaro may update this Privacy Policy at any time, with or without advance notice. In the
        event there are significant changes in the way EarnKaro treats User Information, or in the
        Privacy Policy itself, EarnKaro will display a notice on the Website or send Users an email,
        as provided for above, so that the User may review the changed terms prior to continuing to
        use the Services. As always, if the User objects to any of the changes to our terms, and the
        User no longer wish to use the Services, the User may communicate the same to
        support@earnkaro.com to deactivate Your account. Unless stated otherwise, the current
        Privacy Policy applies to all information that EarnKaro has about You and Your account.
      </p>
      <p className="mt-4">
        If a User uses the Services after a notice of changes has been sent to such User or
        published on the Platform, such User hereby provides his/her/its consent to the changed
        terms.
      </p>

      <h2 className="mt-10 font-display text-xl font-bold">15. ADDRESS FOR PRIVACY QUESTIONS</h2>
      <p className="mt-4">
        Should You have any questions about this Privacy Policy or EarnKaro&rsquo;s information
        collection, use and disclosure practices, You may contact, the Data Protection Officer
        appointed by EarnKaro. We will use reasonable efforts to respond promptly to any requests,
        questions or concerns, which You may have regarding our use of Your Personal Information. If
        You have any grievance with respect to Our use of Your information, You may communicate such
        grievance to the Data Protection Officer:
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
