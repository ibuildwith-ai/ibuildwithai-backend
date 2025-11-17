const { Resend } = require('resend');

// Rate limiting storage (in-memory, resets on function cold start)
const rateLimitStore = new Map();

exports.handler = async (event, context) => {
  // CORS headers for all responses
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
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
    const maxRequests = 5;

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

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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

    // Prepare email content for user (with admin BCC)
    const emailSubject = 'Your iBuildWith.ai reminder is set!';
    const emailContent = `Hi ${firstName},

Your reminder is set! Here are the details:

Your name: ${firstName} ${lastName}
Your email: ${email}

The page you requested a reminder for:

${(pageTitle || 'Page title not available').replace('| iBuildWith.ai', '').trim()}
${pageUrl || 'Page URL not available'}

Learn more at iBuildWith.ai`;

    console.log(`[REMINDER-FORM] Sending reminder confirmation email to: ${email}`);

    // Send email to user with BCC to admin
    const { data, error } = await resend.emails.send({
      from: 'contact@send.ibuildwith.ai',
      to: [email],
      bcc: [process.env.REMINDER_ADMIN_EMAIL],
      subject: emailSubject,
      text: emailContent
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

    console.log('[REMINDER-FORM] Email sent successfully:', data);
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