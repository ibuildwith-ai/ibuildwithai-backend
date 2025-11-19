const { Resend } = require('resend');

// Rate limiting storage (in-memory, resets on function cold start)
const rateLimitStore = new Map();

exports.handler = async (event, context) => {
  // CORS headers for all responses - Restricted to domain only
  const corsHeaders = {
    'Access-Control-Allow-Origin': 'https://ibuildwith.ai',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400'
  };

  // Handle preflight requests
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: ''
    };
  }

  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
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

    if (rateLimitStore.has(clientIP)) {
      const { count, firstRequest } = rateLimitStore.get(clientIP);

      if (now - firstRequest < windowMs) {
        if (count >= maxRequests) {
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

    // Validate required fields
    const { firstName, lastName, email, reason, message } = formData;

    if (!firstName || !lastName || !email || !message) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Missing required fields: firstName, lastName, email, message'
        })
      };
    }

    // Basic email validation - requires valid TLD (min 2 characters)
    const emailRegex = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(email)) {
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

    // Prepare email content
    const emailSubject = 'New Contact Form Submission - iBuildWith.ai';
    const emailContent = `
New contact form submission from iBuildWith.ai

Name: ${firstName} ${lastName}
Email: ${email}
Reason: ${reason || 'Not specified'}
Message: ${message}

Submitted: ${timestamp}
IP Address: ${clientIP}
User Agent: ${event.headers['user-agent'] || 'Not available'}

---
This email was sent from the iBuildWith.ai contact form.
    `.trim();

    // Send email
    const { data, error } = await resend.emails.send({
      from: 'contact@send.ibuildwith.ai',
      to: [process.env.RECIPIENT_EMAIL],
      subject: emailSubject,
      text: emailContent
    });

    if (error) {
      console.error('Resend error:', error);
      return {
        statusCode: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Failed to send email. Please try again later.'
        })
      };
    }

    console.log('Email sent successfully:', data);

    // Return success response
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        message: 'Your message has been sent successfully!'
      })
    };

  } catch (error) {
    console.error('Function error:', error);

    return {
      statusCode: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Internal server error. Please try again later.'
      })
    };
  }
};