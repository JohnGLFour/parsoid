/*
 * Generic attribute expansion handler.
 */
"use strict";

var request = require('request'),
	events = require('events'),
	qs = require('querystring'),
	Util = require('./mediawiki.Util.js').Util,
	ParserFunctions = require('./ext.core.ParserFunctions.js').ParserFunctions,
	AttributeTransformManager = require('./mediawiki.TokenTransformManager.js')
									.AttributeTransformManager,
	defines = require('./mediawiki.parser.defines.js');

/**
 * @class
 *
 * Generic attribute expansion handler.
 *
 * @constructor
 * @param {Object} manager The manager for this stage of the parse.
 * @param {Object} options Any options for the expander.
 */
function AttributeExpander ( manager, options ) {
	this.manager = manager;
	this.options = options;
	// XXX: only register for tag tokens?
	manager.addTransform( this.onToken.bind(this), "AttributeExpander:onToken",
			this.rank, 'any' );
}

// constants
AttributeExpander.prototype.rank = 1.12;

/**
 * Token handler
 *
 * Expands target and arguments (both keys and values) and either directly
 * calls or sets up the callback to _expandTemplate, which then fetches and
 * processes the template.
 *
 * @private
 * @param {Token} token -- token whose attrs being expanded
 * @param {Frame} frame -- unused here, passed in by AsyncTTM to all handlers
 * @param {Function} cb -- callback receiving the expanded token
 */
AttributeExpander.prototype.onToken = function ( token, frame, cb ) {
	// console.warn( 'AttributeExpander.onToken: ', JSON.stringify( token ) );
	if ( (token.constructor === TagTk ||
			token.constructor === SelfclosingTagTk) &&
				token.attribs &&
				token.attribs.length ) {
		var atm = new AttributeTransformManager(
					this.manager,
					{ wrapTemplates: this.options.wrapTemplates },
					this._returnAttributes.bind( this, token, cb )
				);
		cb( { async: true } );
		atm.process(token.attribs);
	} else {
		cb ( { tokens: [token] } );
	}
};

/**
 * Callback for attribute expansion in AttributeTransformManager
 *
 * @private
 */
AttributeExpander.prototype._returnAttributes = function ( token, cb, newAttrs )
{
	this.manager.env.dp( 'AttributeExpander._returnAttributes: ', newAttrs );

	var modified = false;
	var metaTokens = [];
	var oldAttrs   = token.attribs;
	var a, newA, newK, i, l, metaObjType, producerObjType, kv, updatedK, updatedV;

	// Identify attributes that were generated in full or in part using templates
	// and add appropriate meta tags for them.
	for (i = 0, l = oldAttrs.length; i < l; i++) {
		a    = oldAttrs[i];
		newA = newAttrs[i];
		newK = newA.k;

		// Preserve the key and value source, if available
		// But, if 'a' wasn't cloned, newA will be the same as a.
		// Dont try to update it and crash since a is frozen.
		if (a !== newA) {
			if (a.ksrc) {
				newA.ksrc = a.ksrc;
			}
			if (a.vsrc) {
				newA.vsrc = a.vsrc;
			}
			if (a.srcOffsets) {
				newA.srcOffsets = a.srcOffsets;
			}
		}

		if (newK) {
			var contentType = "objectAttrKey"; // default
			if (a.k.constructor === Array) {
				if ( newK.constructor === String && newK.match( /mw\:maybeContent/ ) ) {
					updatedK = Util.stripMetaTags( 'mw:keyAffected', this.options.wrapTemplates );
					newAttrs.push( new KV( 'mw:keyAffected', newA.v ) );
					newK = updatedK.value;
				} else {
					updatedK = Util.stripMetaTags(newK, this.options.wrapTemplates);
					newK = updatedK.value;
					if (newA.v === '') {
						// Some templates can return content that should be
						// interpreted as a key-value pair.
						// Ex: {{GetStyle}} can return style='color:red;'
						// and might be used as <div {{GetStyle}}>foo</div> to
						// generate: <div style='color:red;'>foo</div>.
						//
						// To support this, we utilize the following hack.
						// If we got a string of the form "k=v" and our orig-v
						// was empty, then, we split the template content around
						// the '=' and update the 'k' and 'v' to the split values.
						var kArr = Util.tokensToString(newK, true);
						var kStr = (kArr.constructor === String) ? kArr : kArr[0];
						var m    = kStr.match(/([^=]+)=['"]?([^'"]*)['"]?$/);
						if (m) {
							contentType = "objectAttr"; // both key and value
							newK = m[1];
							if (kArr.constructor === String) {
								newA.v = m[2];
							} else {
								kArr[0] = m[2];
								newA.v = kArr;
							}
						}
					}
					newA.k = newK;
				}

				if ( updatedK ) {
					modified = true;
					metaObjType = updatedK.metaObjType;
					if (metaObjType) {
						producerObjType = metaObjType;
						metaTokens.push( Util.makeTplAffectedMeta(contentType, newK, updatedK) );
					}
				}
			} else if (newK !== a.k) {
				modified = true;
			}


			// We have a string key and potentially expanded value.
			// Check if the value came from a template/extension expansion.
			if (newK.constructor === String && a.v.constructor === Array) {
				modified = true;
				if (newK.match( /mw\:maybeContent/ ) ) {
					// For mw:maybeContent attributes, at this point, we do not really know
					// what this attribute represents.
					//
					// - For regular links and images [[Foo|bar]], this attr (bar) represents
					//   link text which transforms to a DOM sub-tree. If 'bar' comes from
					//   a template, we can let template meta tags stay in the DOM sub-tree.
					//
					// - For categories [[Category:Foo|bar]], this attr (bar) is just a sort
					//   key that will be part of the href attr and will not be a DOM subtree.
					//   If 'bar' comes from a template, we have to strip all meta tags from
					//   the token stream of 'bar' and add new meta tags outside the category
					//   token recording the fact that the sort key in the href came from
					//   a template.
					//
					// We have to wait for all templates to be expanded before we know the
					// context (wikilink/category) this attr is showing up in. So, if this
					// attr has been generated by a template/extension, keep around both the
					// original as well as the stripped versions of the template-generated
					// attr, and in the link handler, we will pick the right version.
					updatedV = Util.stripMetaTags( newA.v, this.options.wrapTemplates );
					metaObjType = updatedV.metaObjType;
					if (metaObjType) {
						kv = new KV('mw:valAffected', [
							metaObjType,
							Util.makeTplAffectedMeta("objectAttrVal", newK, updatedV)
						]);
						newAttrs.push( kv );
					}
				} else if (!newK.match(/^mw:/)) {
					updatedV = Util.stripMetaTags( newA.v, this.options.wrapTemplates );
					newA.v = updatedV.value;
					metaObjType = updatedV.metaObjType;
					if (metaObjType) {
						producerObjType = metaObjType;
						metaTokens.push( Util.makeTplAffectedMeta("objectAttrVal", newK, updatedV) );
					}
				}
			} else if (newA.v !== a.v) {
				modified = true;
			}
		}
	}

	var tokens = [];

	// clone the token and update attrs
	if (modified) {
		// dont clone attribs since they will be replaced
		token = token.clone(false);
		token.attribs = newAttrs;
		token.dataAttribs = Util.clone(token.dataAttribs);

		// Update metatoken info
		l = metaTokens.length;
		if (l > 0) {
			var tokenId = token.getAttribute( 'about' );

			if ( !tokenId ) {
				tokenId = "#" + this.manager.env.newObjectId();
				token.addAttribute("about", tokenId);
				token.addSpaceSeparatedAttribute("typeof", "mw:ExpandedAttrs/" + producerObjType.substring("mw:Object/".length));
			}

			for (i = 0; i < l; i++) {
				metaTokens[i].addAttribute("about", tokenId);
			}
		}
		tokens = metaTokens;
		// console.warn("NEW TOK: " + JSON.stringify(token));
	}

	tokens.push(token);

	cb( { tokens: tokens } );
};

if (typeof module === "object") {
	module.exports.AttributeExpander = AttributeExpander;
}
