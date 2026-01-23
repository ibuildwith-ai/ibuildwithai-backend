const { Resend } = require('resend');

// Rate limiting storage (in-memory, resets on function cold start)
const rateLimitStore = new Map();

exports.handler = async (event, context) => {
  // CORS headers for all responses - Allow both www and non-www domains
  const origin = event.headers.origin || event.headers.Origin;
  const allowedOrigins = ['https://ibuildwith.ai', 'https://www.ibuildwith.ai'];
  const corsOrigin = allowedOrigins.includes(origin) ? origin : 'https://ibuildwith.ai';

  const corsHeaders = {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400'
  };

  // Handle preflight requests
  if (event.httpMethod === 'OPTIONS') {
    console.log('[REMINDER-FORM] Handling OPTIONS preflight request');
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: ''
    };
  }

  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    console.log(`[REMINDER-FORM] Method not allowed: ${event.httpMethod}`);
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    // Rate limiting by IP
    const clientIP = event.headers['client-ip'] || event.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    const windowMs = 60 * 60 * 1000; // 1 hour
    const maxRequests = 3; // Reduced from 5 for better security

    console.log(`[REMINDER-FORM] Processing request from IP: ${clientIP}`);

    if (rateLimitStore.has(clientIP)) {
      const { count, firstRequest } = rateLimitStore.get(clientIP);

      if (now - firstRequest < windowMs) {
        if (count >= maxRequests) {
          console.log(`[REMINDER-FORM] Rate limit exceeded for IP: ${clientIP}`);
          return {
            statusCode: 429,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              error: 'Too many requests. Please wait before submitting again.'
            })
          };
        }
        rateLimitStore.set(clientIP, { count: count + 1, firstRequest });
      } else {
        // Reset the window
        rateLimitStore.set(clientIP, { count: 1, firstRequest: now });
      }
    } else {
      rateLimitStore.set(clientIP, { count: 1, firstRequest: now });
    }

    // Parse form data
    const formData = JSON.parse(event.body);
    console.log('[REMINDER-FORM] Form data received:', {
      firstName: formData.firstName,
      lastName: formData.lastName,
      email: formData.email,
      pageUrl: formData.pageUrl ? formData.pageUrl.substring(0, 100) + '...' : 'not provided',
      pageTitle: formData.pageTitle || 'not provided'
    });

    // Validate required fields
    const { firstName, lastName, email, pageUrl, pageTitle } = formData;

    if (!firstName || !lastName || !email) {
      console.log('[REMINDER-FORM] Missing required fields');
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Missing required fields: firstName, lastName, email'
        })
      };
    }

    // Basic email validation - requires valid TLD (min 2 characters)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(email)) {
      console.log(`[REMINDER-FORM] Invalid email format: ${email}`);
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Invalid email format'
        })
      };
    }

    // Add to Sender.net and track status
    let senderStatus = 'success';
    let senderErrorDetails = '';

    if (process.env.SENDER_API_TOKEN) {
      try {
        console.log(`[REMINDER-FORM] Adding ${email} to Sender.net`);
        const addSubscriberResponse = await fetch('https://api.sender.net/v2/subscribers', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.SENDER_API_TOKEN}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            email: email,
            firstname: firstName,
            lastname: lastName
          }),
          signal: AbortSignal.timeout(5000) // 5 second timeout
        });

        const subscriberData = await addSubscriberResponse.json();

        if (!addSubscriberResponse.ok) {
          // Check if subscriber already exists
          if (addSubscriberResponse.status === 422 ||
              (subscriberData.message && subscriberData.message.includes('already exists'))) {
            console.log(`[REMINDER-FORM] Email ${email} is already subscribed to Sender.net.`);
            senderStatus = 'already_exists';
          } else {
            senderStatus = 'failed';
            senderErrorDetails = `Status: ${addSubscriberResponse.status}, Message: ${subscriberData.message || addSubscriberResponse.statusText}`;
            console.error(`[REMINDER-FORM] Sender.net API error: ${subscriberData.message || addSubscriberResponse.statusText}`);
          }
        } else {
          console.log(`[REMINDER-FORM] Successfully added ${email} to Sender.net`);
          senderStatus = 'success';
        }
      } catch (senderError) {
        console.error('[REMINDER-FORM] Sender.net Error:', senderError);
        senderStatus = 'failed';
        if (!senderErrorDetails) {
          senderErrorDetails = senderError.message;
        }
      }
    } else {
      console.warn('[REMINDER-FORM] Sender.net API token not set. Skipping Sender.net integration.');
      senderStatus = 'skipped';
    }

    // Initialize Resend
    const resend = new Resend(process.env.RESEND_API_KEY);

    // Get current timestamp
    const timestamp = new Date().toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    // Prepare email content for user
    const userEmailSubject = 'Your iBuildWith.ai reminder is set!';
    const userEmailContent = `Hi ${firstName},

Your reminder is set! Here are the details:

Your name: ${firstName} ${lastName}
Your email: ${email}

The page you requested a reminder for:

${(pageTitle || 'Page title not available').replace('| iBuildWith.ai', '').trim()}
${pageUrl || 'Page URL not available'}

Learn more at iBuildWith.ai`;

    // Prepare admin notification email with Sender.net status
    let adminEmailContent = `
New Podcast Reminder Request:

First Name: ${firstName}
Last Name: ${lastName}
Email: ${email}

Podcast Page:
${(pageTitle || 'Page title not available').replace('| iBuildWith.ai', '').trim()}
${pageUrl || 'Page URL not available'}

Date: ${timestamp}

Sender.net Status: ${senderStatus}`;

    if (senderStatus === 'failed') {
      adminEmailContent += `

⚠️ ACTION REQUIRED: Failed to add subscriber to Sender.net
Please manually add this subscriber to your Sender.net list.

Error Details: ${senderErrorDetails}`;
    } else if (senderStatus === 'already_exists') {
      adminEmailContent += `

Note: This email already exists in Sender.net.`;
    }

    console.log(`[REMINDER-FORM] Sending reminder confirmation email to: ${email}`);

    // Send email to user
    const { data, error } = await resend.emails.send({
      from: 'contact@send.ibuildwith.ai',
      to: [email],
      subject: userEmailSubject,
      text: userEmailContent
    });

    if (error) {
      console.error('[REMINDER-FORM] Resend error:', error);
      return {
        statusCode: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Failed to send email. Please try again later.'
        })
      };
    }

    console.log('[REMINDER-FORM] User confirmation email sent successfully:', data);

    // Send separate admin notification with Sender.net status
    try {
      await resend.emails.send({
        from: 'contact@send.ibuildwith.ai',
        to: [process.env.REMINDER_ADMIN_EMAIL],
        subject: senderStatus === 'failed'
          ? `⚠️ Podcast Reminder - MANUAL ADD REQUIRED - ${firstName} ${lastName}`
          : `New Podcast Reminder from ${firstName} ${lastName}`,
        text: adminEmailContent
      });
      console.log('[REMINDER-FORM] Admin notification sent successfully');
    } catch (adminEmailError) {
      console.error('[REMINDER-FORM] Admin notification email error:', adminEmailError);
      // Don't fail the request if admin notification fails
    }

    console.log(`[REMINDER-FORM] Reminder set for ${firstName} ${lastName} (${email}) on page: ${pageTitle}`);

    // Return success response
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        message: 'Your reminder has been set successfully!'
      })
    };

  } catch (error) {
    console.error('[REMINDER-FORM] Function error:', error);

    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Internal server error. Please try again later.'
      })
    };
  }
};